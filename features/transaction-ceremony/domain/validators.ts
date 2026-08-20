import { decodeFunctionData, getAddress, hashTypedData } from 'viem'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import { canonicalDigest, toCanonicalValue } from './canonical'
import type { EffectNode } from './effects'
import type { OperationIntent } from './intents'
import type { EoaRequest, ExecutionTemplate, SafeCall, SignatureSlot } from './template'
import { collectPlanningRequirements } from '../planning/requirements'
import { assertOperationIntent } from './schemas'
import { inferIntentConstraints } from './factory'

const SWAP_PLANNERS = new Set([
  'deposit-with-swap', 'withdraw-and-swap', 'redeem-and-swap', 'swap-and-borrow',
  'repay-with-swap', 'swap-and-repay', 'swap-from-wallet', 'swap-collateral',
  'swap-debt', 'multiply-with-swap',
])

const INFERABLE_PLANNERS = new Set([
  'deposit', 'withdraw', 'redeem', 'borrow', 'repay-from-wallet', 'repay-from-deposit',
  'migrate-same-asset-collateral', 'migrate-same-asset-debt', 'refinance-position',
  'multiply-same-asset', 'transfer',
])

const constraintDigest = (constraint: OperationIntent['constraints'][number]) =>
  canonicalDigest('intent-constraint-v1', toCanonicalValue(constraint))

const assertConstraintPresent = (intent: OperationIntent, expected: OperationIntent['constraints'][number]) => {
  const digest = constraintDigest(expected)
  if (!intent.constraints.some(constraint => constraintDigest(constraint) === digest)) {
    throw new Error(`Intent ${intent.intentId}:${intent.revision} omits planner-enforced ${expected.kind} constraint`)
  }
}

const assertSemanticConstraints = (intent: OperationIntent) => {
  if (INFERABLE_PLANNERS.has(intent.planner.name)) {
    for (const expected of inferIntentConstraints(intent.planner.name, intent.planner.args)) {
      assertConstraintPresent(intent, expected)
    }
  }

  for (const key of ['swapQuote', 'collateralSwapQuote', 'debtSwapQuote'] as const) {
    const candidate = intent.planner.args[key]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const quote = candidate as Record<string, unknown>
    const tokenIn = quote.tokenIn as Record<string, unknown>
    const tokenOut = quote.tokenOut as Record<string, unknown>
    const verify = quote.verify as Record<string, unknown>
    if (tokenIn.chainId !== intent.chainId || tokenOut.chainId !== intent.chainId) {
      throw new Error(`Intent ${intent.intentId}:${intent.revision} contains a cross-chain swap quote`)
    }
    assertConstraintPresent(intent, { kind: 'maximum-input', token: getAddress(tokenIn.address as string), amount: quote.amountInMax as bigint })
    assertConstraintPresent(intent, { kind: 'minimum-output', token: getAddress(tokenOut.address as string), amount: quote.amountOutMin as bigint })
    assertConstraintPresent(intent, { kind: 'deadline', timestamp: verify.deadline as number })
  }
}

export const validateIntentSet = (intents: readonly OperationIntent[]) => {
  if (!intents.length) throw new Error('Intent set is empty')
  const identities = new Set<string>()
  const owner = getAddress(intents[0].account)
  const chainId = intents[0].chainId

  for (const intent of intents) {
    assertOperationIntent(intent)
    const identity = `${intent.intentId}:${intent.revision}`
    if (identities.has(identity)) throw new Error(`Duplicate intent revision ${identity}`)
    identities.add(identity)
    if (getAddress(intent.account) !== owner || intent.chainId !== chainId) throw new Error('Intent set mixes wallet accounts or chains')
    if (!intent.constraints.length) throw new Error(`Intent ${identity} has no bounded outcome`)
    if (SWAP_PLANNERS.has(intent.planner.name)) {
      if (!intent.constraints.some(constraint => constraint.kind === 'minimum-output')) throw new Error(`Swap intent ${identity} has no minimum output`)
      if (!intent.constraints.some(constraint => constraint.kind === 'deadline')) throw new Error(`Swap intent ${identity} has no deadline`)
    }
    if (intent.kind === 'reward-claim' && !intent.constraints.some(constraint => constraint.kind === 'selected-rewards')) {
      throw new Error(`Reward intent ${identity} does not bind the selected claim set`)
    }
    if (intent.kind === 'reul-unlock' && !intent.constraints.some(constraint => constraint.kind === 'remainder-loss')) {
      throw new Error(`rEUL intent ${identity} does not bound remainder loss`)
    }
    assertSemanticConstraints(intent)
  }
}

const validateEffectGraph = (effects: readonly EffectNode[], intents: readonly OperationIntent[]) => {
  const ids = new Set<string>()
  const intentRevisions = new Set(intents.map(intent => `${intent.intentId}:${intent.revision}`))
  for (const [index, node] of effects.entries()) {
    if (ids.has(node.effectId)) throw new Error(`Duplicate effect ID ${node.effectId}`)
    if (!intentRevisions.has(`${node.intentId}:${node.intentRevision}`)) throw new Error(`Effect ${node.effectId} has no owning intent revision`)
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Effect ${node.effectId} depends on a missing or later effect`)
    }
    if (index > 0 && node.dependsOn.length === 0) throw new Error(`Effect ${node.effectId} is disconnected from the ordered graph`)
    const subjectKeys = node.policySubjects.map(subject => `${subject.kind}:${subject.value.toLowerCase()}`)
    if (new Set(subjectKeys).size !== subjectKeys.length) throw new Error(`Effect ${node.effectId} has duplicate policy subjects`)
    const intent = intents.find(candidate => candidate.intentId === node.intentId && candidate.revision === node.intentRevision)
    if (!intent) throw new Error(`Effect ${node.effectId} has no owning intent`)
    const requirements = collectPlanningRequirements([intent])
    const required = [
      ...requirements.accounts.map(value => `account:${value.toLowerCase()}`),
      ...requirements.vaults.map(value => `vault-or-contract:${value.toLowerCase()}`),
      ...requirements.assets.map(value => `asset:${value.toLowerCase()}`),
      ...requirements.contracts.map(value => `vault-or-contract:${value.toLowerCase()}`),
    ]
    const effect = node.effect
    if (effect.kind === 'approval') required.push(`account:${effect.owner.toLowerCase()}`, `asset:${effect.token.toLowerCase()}`, `spender:${effect.spender.toLowerCase()}`)
    else if (effect.kind === 'evc-call' || effect.kind === 'tos-call' || effect.kind === 'keyring-call') required.push(`vault-or-contract:${effect.target.toLowerCase()}`, `account:${effect.onBehalfOfAccount.toLowerCase()}`)
    else if (effect.kind === 'pyth-update') required.push(`vault-or-contract:${effect.target.toLowerCase()}`, `account:${effect.onBehalfOfAccount.toLowerCase()}`, ...effect.requiredFeedIds.map(feed => `pyth-feed:${feed.toLowerCase()}`))
    else if (effect.kind === 'migration-authorization') required.push(`authority:${effect.target.toLowerCase()}`)
    else required.push(`vault-or-contract:${effect.target.toLowerCase()}`)
    for (const requiredSubject of new Set(required)) {
      if (!subjectKeys.includes(requiredSubject)) throw new Error(`Effect ${node.effectId} omits policy subject ${requiredSubject}`)
    }
    ids.add(node.effectId)
  }
}

const requestIdOf = (request: EoaRequest | SafeCall) => 'requestId' in request ? request.requestId : request.callId

const canonicalEqual = (schema: string, left: unknown, right: unknown) =>
  canonicalDigest(schema, toCanonicalValue(left)) === canonicalDigest(schema, toCanonicalValue(right))

const decodeBatchItems = (request: EoaRequest | SafeCall) => {
  try {
    const decoded = decodeFunctionData({ abi: EVC_ABI, data: request.data })
    if (decoded.functionName !== 'batch') throw new Error('not batch')
    return decoded.args[0]
  }
  catch {
    throw new Error(`Request ${requestIdOf(request)} has malformed EVC batch calldata`)
  }
}

const assertRequestMatchesEffect = (request: EoaRequest | SafeCall, node: EffectNode) => {
  const effect = node.effect
  if (request.effectIds.length !== 1) throw new Error(`Non-batch request ${requestIdOf(request)} represents multiple effects`)
  if (effect.kind === 'direct-call') {
    if (request.to !== effect.target || request.data !== effect.data || request.value !== effect.value) {
      throw new Error(`Direct request ${requestIdOf(request)} differs from its effect`)
    }
    return
  }
  if (effect.kind === 'migration-authorization') {
    if (request.to !== effect.target || request.data !== effect.data || request.value !== effect.value) {
      throw new Error(`Migration request ${requestIdOf(request)} differs from its effect`)
    }
    return
  }
  if (effect.kind === 'approval' && effect.mode === 'transaction') {
    const approveAbi = [{
      type: 'function',
      name: 'approve',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }],
    }] as const
    try {
      const decoded = decodeFunctionData({ abi: approveAbi, data: request.data })
      if (
        decoded.functionName !== 'approve'
        || getAddress(decoded.args[0]) !== effect.spender
        || decoded.args[1] !== effect.amount
        || request.to !== effect.token
        || request.value !== 0n
      ) throw new Error('approval mismatch')
    }
    catch {
      throw new Error(`Approval request ${requestIdOf(request)} differs from its effect`)
    }
    return
  }
  throw new Error(`Effect ${node.effectId} is not valid in a non-batch request`)
}

const validateRequestVector = (template: ExecutionTemplate) => {
  const requests = new Map<string, EoaRequest | SafeCall>()
  const effects = new Map(template.effects.map(node => [node.effectId, node]))

  for (const request of template.requests) {
    const requestId = requestIdOf(request)
    if (requests.has(requestId)) throw new Error(`Duplicate execution request ID ${requestId}`)
    requests.set(requestId, request)

    const requestIdentity = {
      effectIds: [...request.effectIds],
      phase: request.phase,
      chainId: template.wallet.chainId,
      from: template.wallet.account,
      to: request.to,
      data: request.data,
      value: request.value,
    }
    if (requestId !== canonicalDigest('execution-request-v1', toCanonicalValue(requestIdentity))) {
      throw new Error(`Execution request ID ${requestId} is inconsistent`)
    }
    if ('requestId' in request && (request.chainId !== template.wallet.chainId || request.from !== template.wallet.account)) {
      throw new Error(`EOA request ${requestId} has a different wallet context`)
    }

    const nodes = request.effectIds.map(effectId => effects.get(effectId))
    if (nodes.some(node => !node)) throw new Error(`Request ${requestId} references a missing effect`)
    const resolvedNodes = nodes as EffectNode[]
    const isBatch = resolvedNodes.some(({ effect }) =>
      effect.kind === 'evc-call'
      || effect.kind === 'tos-call'
      || effect.kind === 'keyring-call'
      || effect.kind === 'pyth-update'
      || (effect.kind === 'approval' && effect.mode === 'permit2'))

    if (!isBatch) {
      assertRequestMatchesEffect(request, resolvedNodes[0]!)
      continue
    }

    const items = decodeBatchItems(request)
    if (items.length !== resolvedNodes.length) throw new Error(`EVC request ${requestId} does not map one-to-one to its effects`)
    if (request.value !== items.reduce((sum, item) => sum + item.value, 0n)) {
      throw new Error(`EVC request ${requestId} has undisclosed native value`)
    }
    for (const [index, node] of resolvedNodes.entries()) {
      const item = items[index]!
      const effect = node.effect
      if (effect.kind === 'approval' && effect.mode === 'permit2') continue
      if (effect.kind !== 'evc-call' && effect.kind !== 'tos-call' && effect.kind !== 'keyring-call' && effect.kind !== 'pyth-update') {
        throw new Error(`Effect ${node.effectId} is not valid in an EVC request`)
      }
      if (
        getAddress(item.targetContract) !== effect.target
        || getAddress(item.onBehalfOfAccount) !== effect.onBehalfOfAccount
        || item.value !== effect.value
        || item.data !== effect.data
      ) throw new Error(`EVC request item ${requestId}:${index} differs from its effect`)
    }
  }

  return requests
}

const typedDataRecord = (value: SignatureSlot['typedData'][string], label: string): Readonly<Record<string, SignatureSlot['typedData'][string]>> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`)
  return value as Readonly<Record<string, SignatureSlot['typedData'][string]>>
}

const typedDataBigInt = (value: SignatureSlot['typedData'][string] | undefined, label: string) => {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  throw new Error(`${label} is malformed`)
}

const validateDynamicSlots = (
  template: ExecutionTemplate,
  requests: ReadonlyMap<string, EoaRequest | SafeCall>,
) => {
  const effects = new Map(template.effects.map(node => [node.effectId, node]))
  const signatureIds = new Set<string>()
  const pythIds = new Set<string>()
  const occupiedCoordinates = new Set<string>()
  const permitEffects = new Map(template.effects
    .filter(node => node.effect.kind === 'approval' && node.effect.mode === 'permit2')
    .map(node => [node.effectId, node]))

  for (const slot of template.signatureSlots) {
    if (signatureIds.has(slot.slotId)) throw new Error(`Duplicate signature slot ID ${slot.slotId}`)
    signatureIds.add(slot.slotId)
    if (slot.chainId !== template.wallet.chainId) throw new Error(`Signature slot ${slot.slotId} targets another chain`)
    if (getAddress(slot.signer) !== getAddress(template.wallet.account)) throw new Error(`Signature slot ${slot.slotId} has a different signer`)
    let recomputedHash: string
    try {
      recomputedHash = hashTypedData(slot.typedData as Parameters<typeof hashTypedData>[0])
    }
    catch {
      throw new Error(`Signature slot ${slot.slotId} contains invalid typed data`)
    }
    if (recomputedHash !== slot.typedDataHash) throw new Error(`Signature slot ${slot.slotId} typed-data digest changed`)
    const domain = typedDataRecord(slot.typedData.domain, 'Typed-data domain')
    if (domain.chainId !== undefined && typedDataBigInt(domain.chainId, 'Typed-data domain chain') !== BigInt(slot.chainId)) {
      throw new Error(`Signature slot ${slot.slotId} typed-data chain changed`)
    }

    for (const insertion of slot.insertionPoints) {
      const request = requests.get(insertion.requestId)
      if (!request) throw new Error(`Signature slot ${slot.slotId} points to a missing request`)
      if (request.effectIds[insertion.batchItemIndex] !== insertion.effectId || !effects.has(insertion.effectId)) {
        throw new Error(`Signature slot ${slot.slotId} points to a different effect`)
      }
      const items = decodeBatchItems(request)
      if (!items[insertion.batchItemIndex]) throw new Error(`Signature slot ${slot.slotId} points outside its EVC batch`)
      const coordinate = `${insertion.requestId}:${insertion.batchItemIndex}`
      if (occupiedCoordinates.has(coordinate)) throw new Error(`Dynamic insertion point ${coordinate} is duplicated`)
      occupiedCoordinates.add(coordinate)

      const node = effects.get(insertion.effectId)!
      if (slot.kind === 'permit2') {
        if (insertion.abiArgumentPath.length !== 1 || insertion.abiArgumentPath[0] !== 'signature') {
          throw new Error(`Permit2 slot ${slot.slotId} has an unexpected ABI path`)
        }
        if (node.effect.kind !== 'approval' || node.effect.mode !== 'permit2') {
          throw new Error(`Permit2 slot ${slot.slotId} points to a non-Permit2 effect`)
        }
      }
      else if (node.effect.kind === 'approval' || node.effect.kind === 'pyth-update') {
        throw new Error(`Migration signature slot ${slot.slotId} points to an incompatible effect`)
      }
    }

    if (slot.kind !== 'permit2') {
      if (slot.nonce !== undefined) throw new Error(`Migration signature slot ${slot.slotId} has a Permit2 nonce`)
      continue
    }
    if (slot.insertionPoints.length !== 1 || slot.nonce === undefined || slot.validUntil === undefined) {
      throw new Error(`Permit2 slot ${slot.slotId} is incomplete`)
    }
    const effectNode = permitEffects.get(slot.insertionPoints[0]!.effectId)
    if (!effectNode || effectNode.effect.kind !== 'approval') throw new Error(`Permit2 slot ${slot.slotId} has no approval effect`)
    const message = typedDataRecord(slot.typedData.message, 'Permit2 message')
    const details = typedDataRecord(message.details, 'Permit2 details')
    if (
      typedDataBigInt(details.nonce, 'Permit2 nonce') !== slot.nonce
      || typedDataBigInt(message.sigDeadline, 'Permit2 signature deadline') !== BigInt(slot.validUntil)
      || getAddress(String(details.token)) !== effectNode.effect.token
      || getAddress(String(message.spender)) !== effectNode.effect.spender
      || slot.signer !== effectNode.effect.owner
    ) throw new Error(`Permit2 slot ${slot.slotId} differs from its approval effect`)
    permitEffects.delete(effectNode.effectId)
  }
  if (permitEffects.size) throw new Error('Permit2 approval effect has no signature slot')

  for (const slot of template.pythRefreshSlots) {
    if (pythIds.has(slot.slotId)) throw new Error(`Duplicate Pyth slot ID ${slot.slotId}`)
    pythIds.add(slot.slotId)
    const insertion = slot.insertionPoint
    const request = requests.get(insertion.requestId)
    const node = effects.get(insertion.effectId)
    if (!request || !node || request.effectIds[insertion.batchItemIndex] !== insertion.effectId) {
      throw new Error(`Pyth slot ${slot.slotId} points to a different request effect`)
    }
    const coordinate = `${insertion.requestId}:${insertion.batchItemIndex}`
    if (occupiedCoordinates.has(coordinate)) throw new Error(`Dynamic insertion point ${coordinate} is duplicated`)
    occupiedCoordinates.add(coordinate)
    const items = decodeBatchItems(request)
    const item = items[insertion.batchItemIndex]
    if (!item) throw new Error(`Pyth slot ${slot.slotId} points outside its EVC batch`)
    if (node.effect.kind !== 'pyth-update') throw new Error(`Pyth slot ${slot.slotId} points to a non-Pyth effect`)
    const effect = node.effect
    if (
      slot.chainId !== template.wallet.chainId
      || slot.chainId !== effect.chainId
      || getAddress(slot.target) !== effect.target
      || slot.selector.toLowerCase() !== effect.selector.toLowerCase()
      || slot.previewValue !== effect.value
      || slot.previewValue > slot.maxValue
    ) throw new Error(`Pyth slot ${slot.slotId} differs from its preview effect`)
    if (!canonicalEqual('pyth-feed-set-v1', [...slot.requiredFeedIds].sort(), [...effect.requiredFeedIds].sort())) {
      throw new Error(`Pyth slot ${slot.slotId} feed set differs from its effect`)
    }
    if (new Set(slot.requiredFeedIds.map(feed => feed.toLowerCase())).size !== slot.requiredFeedIds.length) {
      throw new Error(`Pyth slot ${slot.slotId} has duplicate feeds`)
    }
    if (slot.previewPublishTimes.length !== slot.requiredFeedIds.length) {
      throw new Error(`Pyth slot ${slot.slotId} has incomplete publish-time evidence`)
    }
    if (slot.freshnessPolicy.minimumPublishTime !== undefined && slot.previewPublishTimes.some(time => time < slot.freshnessPolicy.minimumPublishTime!)) {
      throw new Error(`Pyth slot ${slot.slotId} predates its freshness floor`)
    }
    let payloads: readonly `0x${string}`[]
    try {
      const decoded = decodeFunctionData({ abi: PYTH_ABI, data: item.data })
      if (decoded.functionName !== 'updatePriceFeeds') throw new Error('not Pyth')
      payloads = decoded.args[0]
    }
    catch {
      throw new Error(`Pyth slot ${slot.slotId} contains malformed preview calldata`)
    }
    if (slot.previewPayloadHash !== canonicalDigest('pyth-preview-payload-v1', toCanonicalValue(payloads))) {
      throw new Error(`Pyth slot ${slot.slotId} preview payload digest changed`)
    }
    const expectedSlotId = canonicalDigest('pyth-refresh-slot-v1', toCanonicalValue({
      requestId: insertion.requestId,
      effectId: insertion.effectId,
      target: effect.target,
      feedIds: [...slot.requiredFeedIds].sort(),
    }))
    if (slot.slotId !== expectedSlotId) throw new Error(`Pyth slot ${slot.slotId} identity changed`)
  }
}

export const validateExecutionTemplate = (template: ExecutionTemplate, intents: readonly OperationIntent[]) => {
  validateIntentSet(intents)
  validateEffectGraph(template.effects, intents)
  if (!template.effects.length || !template.requests.length) throw new Error('Execution template is empty')

  const represented = new Map<string, number>()
  for (const request of template.requests) {
    if (!request.effectIds.length) throw new Error('Execution request has no effects')
    for (const effectId of request.effectIds) represented.set(effectId, (represented.get(effectId) ?? 0) + 1)
  }
  for (const node of template.effects) {
    if (represented.get(node.effectId) !== 1) throw new Error(`Effect ${node.effectId} is not represented exactly once in the request vector`)
  }
  for (const effectId of represented.keys()) {
    if (!template.effects.some(node => node.effectId === effectId)) throw new Error(`Request references unknown effect ${effectId}`)
  }

  const constraintDigests = new Set(template.constraints.map(constraintDigest))
  for (const intent of intents) {
    for (const constraint of intent.constraints) {
      if (!constraintDigests.has(constraintDigest(constraint))) {
        throw new Error(`Intent ${intent.intentId} constraint is absent from the template`)
      }
    }
  }

  const pythEffects = template.effects.filter(node => node.effect.kind === 'pyth-update')
  if (pythEffects.length !== template.pythRefreshSlots.length) throw new Error('Every Pyth effect must have exactly one refresh slot')
  for (const slot of template.pythRefreshSlots) {
    const node = pythEffects.find(effect => effect.effectId === slot.insertionPoint.effectId)
    if (!node || node.effect.kind !== 'pyth-update') throw new Error('Pyth slot points to a non-Pyth effect')
    if (node.effect.target !== slot.target || node.effect.selector !== slot.selector) throw new Error('Pyth slot does not bind its effect target and selector')
  }

  const requests = validateRequestVector(template)
  validateDynamicSlots(template, requests)
}
