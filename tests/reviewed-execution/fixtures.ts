import { encodeFunctionData, getAddress, keccak256, toHex, type Hash, type TransactionReceipt } from 'viem'
import { MaterializedTransactionRevertedError, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import type { PolicyState, FinalizedRequestSet, ReviewedExecution, PluginPlanBundle, PluginSnapshot, WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { digestPluginPlan, sealReviewedExecution } from '~/features/reviewed-execution/domain/seal'
import { reviewedRequestDigest, materializePreparedPlan, type AdditionalMaterializedCall } from '~/features/reviewed-execution/materialization/prepared-plan'
import { prepareMigrationSignatureEvidence } from '~/features/reviewed-execution/materialization/signature-slots'
import { buildReviewedPolicy, collectPolicyRequirements } from '~/features/reviewed-execution/policy/engine'
import { buildReviewedSimulation } from '~/features/reviewed-execution/simulation/coverage'
import type { EoaMaterializedExecutor } from '~/features/reviewed-execution/adapters/eoa'

export const TEST_ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
export const TEST_TOKEN = getAddress('0x2000000000000000000000000000000000000000')
export const TEST_VAULT = getAddress('0x3000000000000000000000000000000000000000')
export const TEST_EVC = getAddress('0x4000000000000000000000000000000000000000')
export const TEST_PYTH = getAddress('0x5000000000000000000000000000000000000000')

const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-1',
  revision: 1,
  kind: 'deposit',
  chainId: 1,
  account: TEST_ACCOUNT,
  subAccounts: [TEST_ACCOUNT],
  planner: { name: 'deposit', args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TEST_TOKEN, amount: 10n }],
  metadata: { createdAt: 1, source: 'test' },
}

const sdk = {
  deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: TEST_EVC } } }) },
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }),
  },
}

const plan: TransactionPlan = [{
  type: 'evcBatch',
  items: [{ targetContract: TEST_VAULT, onBehalfOfAccount: TEST_ACCOUNT, value: 0n, data: '0x12345678' }],
}]

const fixturePluginPlans = new WeakMap<ReviewedExecution, Readonly<PluginPlanBundle>>()

export const getFixturePluginPlans = (execution: ReviewedExecution): Readonly<PluginPlanBundle> => {
  const plans = fixturePluginPlans.get(execution)
  if (!plans) throw new Error('Fixture plugin plans are unavailable')
  return plans
}

const allowed = (): PolicyState => ({ state: 'allowed', version: 'v1', observedAt: 1, expiresAt: 10_000 })

export const makeReviewedExecution = (
  transport: 'eoa' | 'safe' = 'eoa',
  additional: {
    before?: readonly AdditionalMaterializedCall[]
    after?: readonly AdditionalMaterializedCall[]
    constraints?: OperationIntent['constraints']
    signatureValidUntil?: number
  } = {},
): ReviewedExecution => {
  const wallet: WalletBinding = {
    chainId: 1,
    account: TEST_ACCOUNT,
    subAccounts: [TEST_ACCOUNT],
    connectorId: transport === 'safe' ? 'safe' : 'injected',
    connectorSessionId: 'session-1',
    walletKind: transport,
    ...(transport === 'safe' ? { safeAddress: TEST_ACCOUNT } : {}),
    classificationVersion: 'classification-1',
    approvalMode: 'approve',
  }
  const reviewedIntent: OperationIntent = additional.constraints ? { ...intent, constraints: additional.constraints } : intent
  const migrationSignatureSlots = additional.signatureValidUntil === undefined
    ? []
    : [prepareMigrationSignatureEvidence({
        planItemIndex: 0,
        batchItemIndex: 0,
        signer: TEST_ACCOUNT,
        chainId: 1,
        typedData: {
          domain: { name: 'Test authorization', version: '1', chainId: 1, verifyingContract: TEST_VAULT },
          types: { Authorization: [{ name: 'owner', type: 'address' }] },
          primaryType: 'Authorization',
          message: { owner: TEST_ACCOUNT },
        },
        validUntil: additional.signatureValidUntil,
        abiArgumentPath: ['signature'],
      })]
  const safeAtomicCapability = transport === 'safe' ? { status: 'supported' as const } : undefined
  const preliminary = materializePreparedPlan({ intents: [reviewedIntent], plan, wallet, sdk, before: additional.before, after: additional.after, migrationSignatureSlots, safeAtomicCapability, policyDigest: keccak256(toHex('pending')) })
  const results = collectPolicyRequirements(preliminary).map(requirement => ({ ...requirement, result: allowed() }))
  const policy = buildReviewedPolicy({ requestSet: preliminary, results, now: 10 })
  const requestSet = materializePreparedPlan({ intents: [reviewedIntent], plan, wallet, sdk, before: additional.before, after: additional.after, migrationSignatureSlots, safeAtomicCapability, policyDigest: policy.digest })
  const requestDigest = reviewedRequestDigest(requestSet)
  const pluginPlans: PluginPlanBundle = { rawPlan: plan as never, previewPlan: plan as never }
  const plugins: PluginSnapshot = {
    rawPlanDigest: digestPluginPlan('raw', plan as never),
    previewPlanDigest: digestPluginPlan('preview', plan as never),
    pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
  }
  const execution = sealReviewedExecution({
    intents: [reviewedIntent],
    requestSet: requestSet,
    policy: policy,
    simulation: buildReviewedSimulation({ requestSet, requestDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    pluginSnapshot: plugins,
    pluginPlans,
    validity: { createdAt: 10, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy')) },
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
  fixturePluginPlans.set(execution, pluginPlans)
  return execution
}

export const makePythReviewedExecution = ({ includePrerequisite = true }: { includePrerequisite?: boolean } = {}): ReviewedExecution => {
  const wallet: WalletBinding = {
    chainId: 1,
    account: TEST_ACCOUNT,
    subAccounts: [TEST_ACCOUNT],
    connectorId: 'injected',
    connectorSessionId: 'session-1',
    walletKind: 'eoa',
    classificationVersion: 'classification-1',
    approvalMode: 'approve',
  }
  const approveData = encodeFunctionData({
    abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
    functionName: 'approve',
    args: [TEST_VAULT, 10n],
  })
  const rawApproval: TransactionPlan[number] = { type: 'requiredApproval', token: TEST_TOKEN, owner: TEST_ACCOUNT, spender: TEST_VAULT, amount: 10n }
  const resolvedApproval: TransactionPlan[number] = {
    ...rawApproval,
    resolved: [{ type: 'approve', token: TEST_TOKEN, owner: TEST_ACCOUNT, spender: TEST_VAULT, amount: 10n, data: approveData }],
  }
  const pythPlan: TransactionPlan[number] = {
    type: 'evcBatch',
    items: [
      {
        targetContract: TEST_PYTH,
        onBehalfOfAccount: TEST_ACCOUNT,
        value: 2n,
        data: encodeFunctionData({ abi: PYTH_ABI, functionName: 'updatePriceFeeds', args: [['0x0102']] }),
      },
      ...(plan[0]!.type === 'evcBatch' ? plan[0]!.items : []),
    ],
  }
  const rawPlan: TransactionPlan = includePrerequisite ? [rawApproval, ...plan] : [...plan]
  const previewPlan: TransactionPlan = includePrerequisite ? [resolvedApproval, pythPlan] : [pythPlan]
  const pythPlanItemIndex = includePrerequisite ? 1 : 0
  const pythPreviewData = [{
    planItemIndex: pythPlanItemIndex,
    batchItemIndex: 0,
    target: TEST_PYTH,
    requiredFeedIds: [keccak256(toHex('feed'))],
    publishTimes: [90],
    maxValue: 10n,
    freshnessPolicy: { maximumAgeSeconds: 60, minimumPublishTime: 80 },
  }]
  const preliminary = materializePreparedPlan({ intents: [intent], plan: previewPlan, wallet, sdk, pythPreviewData, policyDigest: keccak256(toHex('pending')) })
  const results = collectPolicyRequirements(preliminary).map(requirement => ({ ...requirement, result: allowed() }))
  const policy = buildReviewedPolicy({ requestSet: preliminary, results, now: 10 })
  const requestSet = materializePreparedPlan({ intents: [intent], plan: previewPlan, wallet, sdk, pythPreviewData, policyDigest: policy.digest })
  const requestDigest = reviewedRequestDigest(requestSet)
  const pluginPlans: PluginPlanBundle = { rawPlan: rawPlan as never, previewPlan: previewPlan as never }
  const plugins: PluginSnapshot = {
    rawPlanDigest: digestPluginPlan('raw', rawPlan as never),
    previewPlanDigest: digestPluginPlan('preview', previewPlan as never),
    pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
  }
  const execution = sealReviewedExecution({
    intents: [intent],
    requestSet,
    policy,
    simulation: buildReviewedSimulation({ requestSet, requestDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    pluginSnapshot: plugins,
    pluginPlans,
    validity: { createdAt: 10, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy')) },
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
  fixturePluginPlans.set(execution, pluginPlans)
  return execution
}

export const artifactFor = (execution: ReviewedExecution): FinalizedRequestSet => ({
  __finalizedRequestSet: true,
  reviewId: execution.reviewId,
  requestDigest: execution.requestDigest,
  transport: execution.requestSet.transport,
  requests: execution.requestSet.requests,
  ...(execution.requestSet.safeTransport ? { safeTransport: execution.requestSet.safeTransport } : {}),
  signatureValues: [],
  pythValues: [],
})

export const materializedExecutorFor = (
  waitForTransactionReceipt: (hash: Hash) => Promise<Pick<TransactionReceipt, 'transactionHash' | 'status'>>,
): EoaMaterializedExecutor => async (execution, options) => {
  await options.onFinalized?.(execution)
  const hashes: Hash[] = []
  const receipts: TransactionReceipt[] = []
  for (const [index, request] of execution.requests.entries()) {
    await options.onBeforeStep?.(request, index)
    const hash = await options.sendTransaction(request)
    hashes.push(hash)
    await options.onTransactionHash?.(request, index, hash)
    const received = await waitForTransactionReceipt(hash)
    if (received.status !== 'success') throw new MaterializedTransactionRevertedError(hash)
    const sdkReceipt = received as TransactionReceipt
    receipts.push(sdkReceipt)
    await options.onAfterStep?.(request, index, hash, sdkReceipt)
  }
  return { execution, hashes, receipts }
}

export const digestForReviewedRequests = (execution: ReviewedExecution): Hash =>
  keccak256(toHex(JSON.stringify(execution.requestSet.requests, (_key, value) => typeof value === 'bigint' ? value.toString() : value)))
