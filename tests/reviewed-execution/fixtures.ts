import { encodeFunctionData, getAddress, keccak256, toHex, type Hash, type TransactionReceipt } from 'viem'
import { MaterializedTransactionRevertedError, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { PolicyState, FinalizedRequestSet, ReviewedExecution, PluginSnapshot, WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { digestPluginPlan, sealReviewedExecution } from '~/features/reviewed-execution/domain/seal'
import { reviewedRequestDigest, materializePreparedPlan, type AdditionalMaterializedCall } from '~/features/reviewed-execution/materialization/prepared-plan'
import { buildReviewedPolicy, collectPolicyRequirements } from '~/features/reviewed-execution/policy/engine'
import { buildReviewedSimulation } from '~/features/reviewed-execution/simulation/coverage'
import type { EoaAdapterClient, EoaMaterializedExecutor } from '~/features/reviewed-execution/adapters/eoa'

export const TEST_ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
export const TEST_TOKEN = getAddress('0x2000000000000000000000000000000000000000')
export const TEST_VAULT = getAddress('0x3000000000000000000000000000000000000000')
export const TEST_EVC = getAddress('0x4000000000000000000000000000000000000000')

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

const allowed = (): PolicyState => ({ state: 'allowed', version: 'v1', observedAt: 1, expiresAt: 10_000 })

export const makeReviewedExecution = (
  transport: 'eoa' | 'safe' = 'eoa',
  additional: { before?: readonly AdditionalMaterializedCall[], after?: readonly AdditionalMaterializedCall[] } = {},
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
  const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, ...additional, policyDigest: keccak256(toHex('pending')) })
  const results = collectPolicyRequirements(preliminary).map(requirement => ({ ...requirement, result: allowed() }))
  const policy = buildReviewedPolicy({ requestSet: preliminary, results, now: 10 })
  const requestSet = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, ...additional, policyDigest: policy.digest })
  const requestDigest = reviewedRequestDigest(requestSet)
  const plugins: PluginSnapshot = {
    rawPlan: plan as never,
    previewPlan: plan as never,
    rawPlanDigest: digestPluginPlan('raw', plan as never),
    previewPlanDigest: digestPluginPlan('preview', plan as never),
    pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
  }
  return sealReviewedExecution({
    intents: [intent],
    requestSet: requestSet,
    policy: policy,
    simulation: buildReviewedSimulation({ requestSet, requestDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    pluginSnapshot: plugins,
    validity: { createdAt: 10, expiresAt: 9_000, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy')) },
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
}

export const artifactFor = (execution: ReviewedExecution): FinalizedRequestSet => ({
  __finalizedRequestSet: true,
  reviewId: execution.reviewId,
  requestDigest: execution.requestDigest,
  transport: execution.requestSet.transport,
  requests: execution.requestSet.requests,
  signatureValues: [],
  pythValues: [],
})

export const materializedExecutorFor = (client: EoaAdapterClient): EoaMaterializedExecutor => async (execution, options) => {
  await options.onFinalized?.(execution)
  const hashes: Hash[] = []
  const receipts: TransactionReceipt[] = []
  for (const [index, request] of execution.requests.entries()) {
    await options.onBeforeStep?.(request, index)
    const hash = await options.sendTransaction(request)
    hashes.push(hash)
    await options.onTransactionHash?.(request, index, hash)
    const received = await client.waitForTransactionReceipt(hash)
    if (received.status !== 'success') throw new MaterializedTransactionRevertedError(hash)
    const sdkReceipt = received as TransactionReceipt
    receipts.push(sdkReceipt)
    await options.onAfterStep?.(request, index, hash, sdkReceipt)
  }
  return { execution, hashes, receipts }
}

export const digestForReviewedRequests = (execution: ReviewedExecution): Hash =>
  keccak256(toHex(JSON.stringify(execution.requestSet.requests, (_key, value) => typeof value === 'bigint' ? value.toString() : value)))
