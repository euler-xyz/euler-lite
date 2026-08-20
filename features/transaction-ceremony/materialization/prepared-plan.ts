import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector, type Address, type Hash, type Hex } from 'viem'
import { flattenBatchEntries, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { PYTH_ABI } from '~/abis/pyth'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { EffectNode, EffectPolicySubject, EffectProvenance, EffectPhase, SimulationCoverage, TypedEffect } from '../domain/effects'
import type { OperationIntent } from '../domain/intents'
import type { EoaRequest, ExecutionTemplate, PythRefreshSlot, SafeCall, SignatureSlot, WalletBinding } from '../domain/template'
import type { PreparedMigrationSignatureSlot, PreparedPermit2Slot } from './signature-slots'
import { collectPlanningRequirements } from '../planning/requirements'

const PYTH_SELECTOR = toFunctionSelector('updatePriceFeeds(bytes[])')
const TOS_SELECTOR = toFunctionSelector('signTermsOfUse(string,bytes32)')
const KEYRING_SELECTOR = toFunctionSelector('createCredential(address,uint256,uint256,uint256,uint256,bytes,bytes,bytes)')

export interface PlanMaterializationSdk {
  deploymentService: {
    getDeployment: (chainId: number) => { addresses: { coreAddrs: { evc?: string } } }
  }
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) => Hex
    materializeExecution?: (args: {
      prepared: {
        __prepared: true
        plan: TransactionPlan
        chainId: number
        account: Address
        usePermit2: boolean
        unlimitedApproval: boolean
      }
      inputs: {
        evcAddress: Address
        permit2: readonly {
          planItemIndex: number
          resolvedIndex: number
          nonce: number
          sigDeadline: bigint
          expiration: number
        }[]
      }
    }) => {
      requests: readonly {
        requestIndex: number
        sourcePlanItemIndex: number
        chainId: number
        from: Address
        to: Address
        data: Hex
        value: bigint
      }[]
      signatureSlots: readonly {
        planItemIndex: number
        resolvedIndex: number
        nonce: number
        validUntil: bigint
        typedDataHash: Hash
        insertion: { requestIndex: number, batchItemIndex: number }
      }[]
    }
  }
}

export interface EffectOwner {
  intentId: string
  intentRevision: number
}

export interface PythPreviewEvidence {
  planItemIndex: number
  batchItemIndex: number
  target: Address
  requiredFeedIds: readonly Hex[]
  publishTimes: readonly number[]
  maxValue: bigint
  freshnessPolicy: {
    maximumAgeSeconds: number
    minimumPublishTime?: number
  }
}

export interface AdditionalMaterializedCall {
  phase: Extract<EffectPhase, 'prerequisite' | 'cleanup'>
  owner: EffectOwner
  provenance: Extract<EffectProvenance, { source: 'migration-authorization' }>
  chainId: number
  to: Address
  data: Hex
  value?: bigint
}

interface PendingRequest {
  effectIds: Hash[]
  phase: EffectPhase
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: bigint
}

const selectorOf = (data: Hex): Hex => data.slice(0, 10) as Hex

const effectOwnerFor = (
  intents: readonly OperationIntent[],
  owners: Readonly<Record<string, EffectOwner>>,
  planItemIndex: number,
  batchItemIndex?: number,
): EffectOwner => {
  const keyed = owners[batchItemIndex === undefined ? `${planItemIndex}` : `${planItemIndex}:${batchItemIndex}`]
  if (keyed) return keyed
  if (intents.length !== 1) {
    throw new Error(`Effect ownership is missing for ${planItemIndex}${batchItemIndex === undefined ? '' : `:${batchItemIndex}`}`)
  }
  return { intentId: intents[0].intentId, intentRevision: intents[0].revision }
}

const makeEffectId = (owner: EffectOwner, coordinates: string, effect: TypedEffect): Hash =>
  canonicalDigest('effect-node-v1', toCanonicalValue({ owner, coordinates, effect }))

const makeRequestId = (request: PendingRequest): Hash =>
  canonicalDigest('execution-request-v1', toCanonicalValue(request))

const permit2MaterializationInput = (slot: PreparedPermit2Slot) => {
  const message = slot.typedData.message
  const details = message.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('Permit2 materialization details are malformed')
  const expiration = Number((details as Record<string, unknown>).expiration)
  const sigDeadline = typeof message.sigDeadline === 'bigint' ? message.sigDeadline : BigInt(String(message.sigDeadline))
  if (!Number.isSafeInteger(expiration) || expiration <= 0 || sigDeadline <= 0n) throw new Error('Permit2 materialization deadlines are invalid')
  return {
    planItemIndex: slot.planItemIndex,
    resolvedIndex: slot.resolvedIndex,
    nonce: slot.nonce,
    sigDeadline,
    expiration,
  }
}

const assertSdkMaterializationMatches = ({
  plan,
  wallet,
  sdk,
  permit2Slots,
  pendingRequests,
  liteSignatureSlots,
}: {
  plan: TransactionPlan
  wallet: WalletBinding
  sdk: PlanMaterializationSdk
  permit2Slots: readonly PreparedPermit2Slot[]
  pendingRequests: readonly PendingRequest[]
  liteSignatureSlots: readonly SignatureSlot[]
}) => {
  const materialize = sdk.executionService.materializeExecution
  if (!materialize) return
  const evc = sdk.deploymentService.getDeployment(wallet.chainId).addresses.coreAddrs.evc
  if (!evc) throw new Error(`EVC address is unavailable for chain ${wallet.chainId}`)
  const materialized = materialize({
    prepared: {
      __prepared: true,
      plan,
      chainId: wallet.chainId,
      account: wallet.account,
      usePermit2: wallet.approvalMode === 'permit2',
      unlimitedApproval: false,
    },
    inputs: {
      evcAddress: getAddress(evc),
      permit2: permit2Slots.map(permit2MaterializationInput),
    },
  })
  if (materialized.requests.length !== pendingRequests.length) throw new Error('SDK materialized a different request count')
  materialized.requests.forEach((actual, index) => {
    const reviewed = pendingRequests[index]
    if (!reviewed
      || actual.requestIndex !== index
      || actual.chainId !== reviewed.chainId
      || getAddress(actual.from) !== getAddress(reviewed.from)
      || getAddress(actual.to) !== getAddress(reviewed.to)
      || actual.data !== reviewed.data
      || actual.value !== reviewed.value) {
      throw new Error(`SDK materialized request ${index} differently from Lite's reviewed effect projection`)
    }
  })
  if (materialized.signatureSlots.length !== permit2Slots.length) throw new Error('SDK materialized a different Permit2 slot count')
  for (const prepared of permit2Slots) {
    const actual = materialized.signatureSlots.find(slot => slot.planItemIndex === prepared.planItemIndex && slot.resolvedIndex === prepared.resolvedIndex)
    const lite = liteSignatureSlots.find(slot => slot.kind === 'permit2' && slot.typedDataHash === prepared.typedDataHash)
    const insertion = lite?.insertionPoints[0]
    const expectedRequestIndex = insertion ? pendingRequests.findIndex(request => makeRequestId(request) === insertion.requestId) : -1
    if (!actual
      || !insertion
      || actual.nonce !== prepared.nonce
      || actual.validUntil !== BigInt(prepared.validUntil)
      || actual.typedDataHash !== prepared.typedDataHash
      || actual.insertion.requestIndex !== expectedRequestIndex
      || actual.insertion.batchItemIndex !== insertion.batchItemIndex) {
      throw new Error(`SDK materialized Permit2 slot ${prepared.planItemIndex}:${prepared.resolvedIndex} differently`)
    }
  }
}

const intentSubjects = (intents: readonly OperationIntent[], owner: EffectOwner): EffectPolicySubject[] => {
  const intent = intents.find(candidate => candidate.intentId === owner.intentId && candidate.revision === owner.intentRevision)
  if (!intent) throw new Error(`Effect owner ${owner.intentId}:${owner.intentRevision} is missing`)
  const requirements = collectPlanningRequirements([intent])
  return [
    ...requirements.accounts.map(value => ({ kind: 'account' as const, value })),
    ...requirements.vaults.map(value => ({ kind: 'vault-or-contract' as const, value })),
    ...requirements.assets.map(value => ({ kind: 'asset' as const, value })),
    ...requirements.contracts.map(value => ({ kind: 'vault-or-contract' as const, value })),
  ]
}

const effectSubjects = (effect: TypedEffect): EffectPolicySubject[] => {
  if (effect.kind === 'approval') return [
    { kind: 'account', value: effect.owner },
    { kind: 'asset', value: effect.token },
    { kind: 'spender', value: effect.spender },
  ]
  if (effect.kind === 'evc-call' || effect.kind === 'tos-call' || effect.kind === 'keyring-call') return [
    { kind: 'vault-or-contract', value: effect.target },
    { kind: 'account', value: effect.onBehalfOfAccount },
  ]
  if (effect.kind === 'pyth-update') return [
    { kind: 'vault-or-contract', value: effect.target },
    { kind: 'account', value: effect.onBehalfOfAccount },
    ...effect.requiredFeedIds.map(value => ({ kind: 'pyth-feed' as const, value })),
  ]
  if (effect.kind === 'migration-authorization') return [{ kind: 'authority', value: effect.target }]
  return [{ kind: 'vault-or-contract', value: effect.target }]
}

const policySubjects = (intents: readonly OperationIntent[], owner: EffectOwner, effect: TypedEffect): EffectPolicySubject[] => {
  const unique = new Map<string, EffectPolicySubject>()
  for (const subject of [...intentSubjects(intents, owner), ...effectSubjects(effect)]) {
    unique.set(`${subject.kind}:${subject.value.toLowerCase()}`, subject)
  }
  return [...unique.values()].sort((left, right) => `${left.kind}:${left.value.toLowerCase()}`.localeCompare(`${right.kind}:${right.value.toLowerCase()}`))
}

const classifyBatchEffect = ({
  chainId,
  item,
  pythEvidence,
}: {
  chainId: number
  item: EVCBatchItem
  pythEvidence?: PythPreviewEvidence
}): { effect: TypedEffect, provenance: EffectProvenance } => {
  const selector = selectorOf(item.data)
  if (selector === PYTH_SELECTOR) {
    if (!pythEvidence) throw new Error('Pyth update is missing sealed feed and freshness evidence')
    if (getAddress(item.targetContract) !== getAddress(pythEvidence.target)) {
      throw new Error('Pyth preview target does not match its evidence')
    }
    return {
      effect: {
        kind: 'pyth-update',
        chainId,
        target: getAddress(item.targetContract),
        onBehalfOfAccount: getAddress(item.onBehalfOfAccount),
        value: item.value,
        data: item.data,
        selector,
        requiredFeedIds: [...pythEvidence.requiredFeedIds].sort(),
      },
      provenance: { source: 'sdk-plugin', plugin: 'pyth' },
    }
  }
  if (selector === TOS_SELECTOR) {
    return {
      effect: { kind: 'tos-call', target: getAddress(item.targetContract), onBehalfOfAccount: getAddress(item.onBehalfOfAccount), value: item.value, data: item.data, selector },
      provenance: { source: 'lite-plugin', plugin: 'tos' },
    }
  }
  if (selector === KEYRING_SELECTOR) {
    return {
      effect: { kind: 'keyring-call', target: getAddress(item.targetContract), onBehalfOfAccount: getAddress(item.onBehalfOfAccount), value: item.value, data: item.data, selector },
      provenance: { source: 'sdk-plugin', plugin: 'keyring' },
    }
  }
  return {
    effect: { kind: 'evc-call', target: getAddress(item.targetContract), onBehalfOfAccount: getAddress(item.onBehalfOfAccount), value: item.value, data: item.data, selector },
    provenance: { source: 'intent', planner: 'sdk-transaction-plan' },
  }
}

const materializeAdditionalCall = (
  input: AdditionalMaterializedCall,
  coordinate: string,
  wallet: WalletBinding,
  intents: readonly OperationIntent[],
): { effect: EffectNode, request: PendingRequest } => {
  if (input.chainId !== wallet.chainId) throw new Error('Migration authorization call targets another chain')
  const typed: TypedEffect = {
    kind: 'migration-authorization',
    action: input.phase === 'prerequisite' ? 'grant' : 'revoke',
    chainId: input.chainId,
    target: getAddress(input.to),
    data: input.data,
    value: input.value ?? 0n,
  }
  const effectId = makeEffectId(input.owner, coordinate, typed)
  const effect: EffectNode = {
    effectId,
    intentId: input.owner.intentId,
    intentRevision: input.owner.intentRevision,
    dependsOn: [],
    phase: input.phase,
    effect: typed,
    provenance: input.provenance,
    simulation: { kind: 'modeled-authorization', assumption: 'Migration authorization is modeled before execution.' },
    policySubjects: policySubjects(intents, input.owner, typed),
  }
  return {
    effect,
    request: {
      effectIds: [effectId],
      phase: input.phase,
      chainId: wallet.chainId,
      from: wallet.account,
      to: typed.target,
      data: typed.data,
      value: typed.value,
    },
  }
}

export const materializePreparedPlan = ({
  intents,
  plan,
  wallet,
  sdk,
  permit2Slots = [],
  migrationSignatureSlots = [],
  pythEvidence = [],
  effectOwners = {},
  before = [],
  after = [],
  directCallAllowlist = {},
  policyEvidenceDigest,
}: {
  intents: readonly OperationIntent[]
  plan: TransactionPlan
  wallet: WalletBinding
  sdk: PlanMaterializationSdk
  permit2Slots?: readonly PreparedPermit2Slot[]
  migrationSignatureSlots?: readonly PreparedMigrationSignatureSlot[]
  pythEvidence?: readonly PythPreviewEvidence[]
  effectOwners?: Readonly<Record<string, EffectOwner>>
  before?: readonly AdditionalMaterializedCall[]
  after?: readonly AdditionalMaterializedCall[]
  directCallAllowlist?: Readonly<Record<string, string>>
  policyEvidenceDigest: Hash
}): Readonly<ExecutionTemplate> => {
  if (!intents.length) throw new Error('Cannot materialize an empty intent set')
  for (const intent of intents) {
    if (intent.chainId !== wallet.chainId || getAddress(intent.account) !== getAddress(wallet.account)) {
      throw new Error('Intent wallet context does not match the materialization binding')
    }
  }

  const effects: EffectNode[] = []
  const pendingRequests: PendingRequest[] = []
  const signatureSlots: SignatureSlot[] = []
  const pythRefreshSlots: PythRefreshSlot[] = []
  const pendingPermitItems: { prepared: PreparedPermit2Slot, effectId: Hash }[] = []

  for (const [index, input] of before.entries()) {
    const materialized = materializeAdditionalCall(input, `before:${index}`, wallet, intents)
    effects.push(materialized.effect)
    pendingRequests.push(materialized.request)
  }

  const planRequestStart = pendingRequests.length

  for (const [planItemIndex, item] of plan.entries()) {
    if (item.type === 'cowSwap') throw new Error('CoW solver-order workflows are outside the reviewed ceremony')

    if (item.type === 'requiredApproval') {
      if (!item.resolved) throw new Error(`Approval at plan item ${planItemIndex} is unresolved`)
      const owner = effectOwnerFor(intents, effectOwners, planItemIndex)
      for (const [resolvedIndex, resolved] of item.resolved.entries()) {
        const effect: TypedEffect = {
          kind: 'approval',
          mode: resolved.type === 'approve' ? 'transaction' : 'permit2',
          owner: getAddress(resolved.owner),
          token: getAddress(resolved.token),
          spender: getAddress(resolved.spender),
          amount: resolved.amount,
        }
        const effectId = makeEffectId(owner, `${planItemIndex}:${resolvedIndex}`, effect)
        effects.push({
          effectId,
          intentId: owner.intentId,
          intentRevision: owner.intentRevision,
          dependsOn: [],
          phase: 'prerequisite',
          effect,
          provenance: { source: 'intent', planner: intents.find(intent => intent.intentId === owner.intentId)?.planner.name ?? 'unknown' },
          simulation: { kind: 'modeled-authorization', assumption: resolved.type === 'approve' ? 'Allowance is modeled with a state override.' : 'Permit2 authorization is modeled with sealed typed data.' },
          policySubjects: policySubjects(intents, owner, effect),
        })

        if (resolved.type === 'approve') {
          pendingRequests.push({ effectIds: [effectId], phase: 'prerequisite', chainId: wallet.chainId, from: wallet.account, to: getAddress(resolved.token), data: resolved.data, value: 0n })
          continue
        }
        if (wallet.approvalMode !== 'permit2' || wallet.walletKind === 'safe') {
          throw new Error('Permit2 approval is incompatible with the sealed wallet binding')
        }
        const prepared = permit2Slots.find(slot => slot.planItemIndex === planItemIndex && slot.resolvedIndex === resolvedIndex)
        if (!prepared) throw new Error(`Permit2 slot ${planItemIndex}:${resolvedIndex} was not prepared before review`)
        pendingPermitItems.push({ prepared, effectId })
      }
      continue
    }

    if (item.type === 'evcBatch') {
      const evc = sdk.deploymentService.getDeployment(wallet.chainId).addresses.coreAddrs.evc
      if (!evc) throw new Error(`EVC address is unavailable for chain ${wallet.chainId}`)
      const flattened = flattenBatchEntries(item.items)
      const encodedItems: EVCBatchItem[] = pendingPermitItems.map(entry => entry.prepared.placeholderBatchItem)
      const requestEffectIds: Hash[] = pendingPermitItems.map(entry => entry.effectId)
      const permitStartIndex = 0
      const pythForItem = pythEvidence.filter(entry => entry.planItemIndex === planItemIndex)

      for (const [batchItemIndex, batchItem] of flattened.entries()) {
        const owner = effectOwnerFor(intents, effectOwners, planItemIndex, batchItemIndex)
        const evidence = pythForItem.find(entry => entry.batchItemIndex === batchItemIndex)
        const classified = classifyBatchEffect({ chainId: wallet.chainId, item: batchItem, pythEvidence: evidence })
        const effectId = makeEffectId(owner, `${planItemIndex}:${batchItemIndex}`, classified.effect)
        effects.push({
          effectId,
          intentId: owner.intentId,
          intentRevision: owner.intentRevision,
          dependsOn: [],
          phase: 'core',
          effect: classified.effect,
          provenance: classified.provenance,
          simulation: { kind: 'evc-state' },
          policySubjects: policySubjects(intents, owner, classified.effect),
        })
        requestEffectIds.push(effectId)
        encodedItems.push(batchItem)
      }

      const request: PendingRequest = {
        effectIds: requestEffectIds,
        phase: 'core',
        chainId: wallet.chainId,
        from: wallet.account,
        to: getAddress(evc),
        data: sdk.executionService.encodeBatch(encodedItems),
        value: encodedItems.reduce((sum, entry) => sum + entry.value, 0n),
      }
      const requestId = makeRequestId(request)
      for (const [offset, pending] of pendingPermitItems.entries()) {
        signatureSlots.push({
          slotId: pending.prepared.slotId,
          kind: 'permit2',
          signer: pending.prepared.signer,
          chainId: pending.prepared.chainId,
          typedData: toCanonicalValue(pending.prepared.typedData) as { readonly [key: string]: import('../domain/canonical').CanonicalValue },
          typedDataHash: pending.prepared.typedDataHash,
          validUntil: pending.prepared.validUntil,
          nonce: BigInt(pending.prepared.nonce),
          insertionPoints: [{ requestId, effectId: pending.effectId, batchItemIndex: permitStartIndex + offset, abiArgumentPath: ['signature'] }],
        })
      }
      for (const prepared of migrationSignatureSlots.filter(slot => slot.planItemIndex === planItemIndex)) {
        const effectId = requestEffectIds[pendingPermitItems.length + prepared.batchItemIndex]
        if (!effectId || !flattened[prepared.batchItemIndex]) throw new Error('Migration signature slot points outside the reviewed EVC batch')
        const slotId = canonicalDigest('signature-slot-v1', toCanonicalValue({
          kind: 'migration',
          signer: prepared.signer,
          chainId: prepared.chainId,
          typedDataHash: prepared.typedDataHash,
          validUntil: prepared.validUntil,
          requestId,
          effectId,
          batchItemIndex: pendingPermitItems.length + prepared.batchItemIndex,
          abiArgumentPath: prepared.abiArgumentPath,
        }))
        signatureSlots.push({
          slotId,
          kind: 'migration',
          signer: prepared.signer,
          chainId: prepared.chainId,
          typedData: toCanonicalValue(prepared.typedData) as SignatureSlot['typedData'],
          typedDataHash: prepared.typedDataHash,
          ...(prepared.validUntil === undefined ? {} : { validUntil: prepared.validUntil }),
          insertionPoints: [{
            requestId,
            effectId,
            batchItemIndex: pendingPermitItems.length + prepared.batchItemIndex,
            abiArgumentPath: [...prepared.abiArgumentPath],
          }],
        })
      }
      for (const evidence of pythForItem) {
        const effect = effects.find(node => node.effect.kind === 'pyth-update' && node.effectId === requestEffectIds[pendingPermitItems.length + evidence.batchItemIndex])
        if (!effect || effect.effect.kind !== 'pyth-update') throw new Error('Pyth evidence does not identify a Pyth update effect')
        let payloads: readonly Hex[]
        try {
          const decoded = decodeFunctionData({ abi: PYTH_ABI, data: effect.effect.data })
          if (decoded.functionName !== 'updatePriceFeeds') throw new Error('unexpected selector')
          payloads = decoded.args[0]
        }
        catch {
          throw new Error('Pyth update calldata is malformed')
        }
        pythRefreshSlots.push({
          slotId: canonicalDigest('pyth-refresh-slot-v1', toCanonicalValue({ requestId, effectId: effect.effectId, target: effect.effect.target, feedIds: [...evidence.requiredFeedIds].sort() })),
          kind: 'pyth-update-v1',
          chainId: wallet.chainId,
          target: effect.effect.target,
          selector: PYTH_SELECTOR,
          requiredFeedIds: [...evidence.requiredFeedIds].sort(),
          maxValue: evidence.maxValue,
          freshnessPolicy: evidence.freshnessPolicy,
          previewPayloadHash: canonicalDigest('pyth-preview-payload-v1', toCanonicalValue(payloads)),
          previewPublishTimes: [...evidence.publishTimes],
          previewValue: effect.effect.value,
          sourcePlanItemIndex: evidence.planItemIndex,
          sourceBatchItemIndex: evidence.batchItemIndex,
          insertionPoint: { requestId, effectId: effect.effectId, batchItemIndex: pendingPermitItems.length + evidence.batchItemIndex },
        })
      }
      pendingPermitItems.length = 0
      pendingRequests.push(request)
      continue
    }

    const owner = effectOwnerFor(intents, effectOwners, planItemIndex)
    if (item.chainId !== wallet.chainId) throw new Error('Direct call targets another chain')
    const data = encodeFunctionData({ abi: item.abi, functionName: item.functionName, args: item.args })
    const directEffect: TypedEffect = { kind: 'direct-call', chainId: item.chainId, target: getAddress(item.to), data, value: item.value, selector: selectorOf(data) }
    const effectId = makeEffectId(owner, `${planItemIndex}`, directEffect)
    const simulationMode = (item as typeof item & { simulationMode?: 'independent' }).simulationMode
    let simulation: SimulationCoverage
    if (simulationMode === 'independent') simulation = { kind: 'independent-call' }
    else {
      const allowlistId = directCallAllowlist[`${item.chainId}:${getAddress(item.to).toLowerCase()}:${item.functionName}`]
      if (!allowlistId) throw new Error(`Direct call ${item.functionName} has no simulation coverage classification`)
      simulation = { kind: 'not-state-simulated', allowlistId }
    }
    effects.push({ effectId, intentId: owner.intentId, intentRevision: owner.intentRevision, dependsOn: [], phase: 'core', effect: directEffect, provenance: { source: 'intent', planner: intents.find(intent => intent.intentId === owner.intentId)?.planner.name ?? 'unknown' }, simulation, policySubjects: policySubjects(intents, owner, directEffect) })
    pendingRequests.push({ effectIds: [effectId], phase: 'core', chainId: wallet.chainId, from: wallet.account, to: directEffect.target, data, value: item.value })
  }

  if (pendingPermitItems.length) throw new Error('Permit2 signature has no following EVC batch insertion point')

  assertSdkMaterializationMatches({
    plan,
    wallet,
    sdk,
    permit2Slots,
    pendingRequests: pendingRequests.slice(planRequestStart),
    liteSignatureSlots: signatureSlots,
  })
  for (const slot of migrationSignatureSlots) {
    if (!signatureSlots.some(candidate => candidate.kind === 'migration' && candidate.typedDataHash === slot.typedDataHash && candidate.signer === slot.signer)) {
      throw new Error('Migration signature has no reviewed EVC insertion point')
    }
  }

  for (const [index, input] of [...after].reverse().entries()) {
    const materialized = materializeAdditionalCall(input, `after:${index}`, wallet, intents)
    effects.push(materialized.effect)
    pendingRequests.push(materialized.request)
  }

  // Preserve the complete ordered operation graph explicitly. This total-order
  // edge is intentionally conservative: callers may add richer dependencies,
  // but no approval, prerequisite, core effect, or cleanup can become orphaned.
  for (let index = 0; index < effects.length; index++) {
    effects[index] = {
      ...effects[index],
      dependsOn: index === 0 ? [] : [effects[index - 1].effectId],
    }
  }

  const requests: EoaRequest[] | SafeCall[] = wallet.walletKind === 'eoa'
    ? pendingRequests.map((request): EoaRequest => ({ requestId: makeRequestId(request), ...request }))
    : pendingRequests.map((request): SafeCall => ({ callId: makeRequestId(request), effectIds: request.effectIds, phase: request.phase, to: request.to, data: request.data, value: request.value }))

  const template: ExecutionTemplate = {
    schemaVersion: 1,
    wallet: {
      ...wallet,
      account: getAddress(wallet.account),
      subAccounts: wallet.subAccounts.map(getAddress),
      ...(wallet.safeAddress ? { safeAddress: getAddress(wallet.safeAddress) } : {}),
    },
    transport: wallet.walletKind,
    effects,
    requests,
    signatureSlots,
    pythRefreshSlots,
    constraints: intents.flatMap(intent => intent.constraints),
    policyEvidenceDigest,
  }

  return deepFreezeSerializable(template) as Readonly<ExecutionTemplate>
}

export const executionTemplateDigest = (template: ExecutionTemplate): Hash =>
  canonicalDigest('execution-template-v1', toCanonicalValue(template))

export const normalizedRequestDigest = (requests: readonly EoaRequest[] | readonly SafeCall[]): Hash =>
  canonicalDigest('normalized-request-vector-v1', toCanonicalValue(requests))

export const pythSelector = PYTH_SELECTOR
