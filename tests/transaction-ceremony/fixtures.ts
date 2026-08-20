import { encodeFunctionData, getAddress, keccak256, toHex, type Hash, type TransactionReceipt } from 'viem'
import { MaterializedTransactionRevertedError, type EVCBatchItem, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { EvidenceState, SealedCeremony, SealedPluginEnvelope } from '~/features/transaction-ceremony/domain/ceremony'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import { digestPluginPlan, sealCeremony } from '~/features/transaction-ceremony/domain/seal'
import type { FinalizedArtifact, WalletBinding } from '~/features/transaction-ceremony/domain/template'
import { executionTemplateDigest, materializePreparedPlan, type AdditionalMaterializedCall } from '~/features/transaction-ceremony/materialization/prepared-plan'
import { buildPolicyEvidence, collectPolicyRequirements } from '~/features/transaction-ceremony/policy/engine'
import { buildSimulationCertificate } from '~/features/transaction-ceremony/simulation/coverage'
import type { EoaAdapterClient, EoaMaterializedExecutor } from '~/features/transaction-ceremony/adapters/eoa'

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

const allowed = (): EvidenceState => ({ state: 'allowed', version: 'v1', observedAt: 1, expiresAt: 10_000 })

export const makeCeremony = (
  transport: 'eoa' | 'safe' = 'eoa',
  additional: { before?: readonly AdditionalMaterializedCall[], after?: readonly AdditionalMaterializedCall[] } = {},
): SealedCeremony => {
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
  const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, ...additional, policyEvidenceDigest: keccak256(toHex('pending')) })
  const evidence = collectPolicyRequirements(preliminary).map(requirement => ({ ...requirement, result: allowed() }))
  const policy = buildPolicyEvidence({ template: preliminary, evidence, now: 10 })
  const template = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, ...additional, policyEvidenceDigest: policy.digest })
  const templateDigest = executionTemplateDigest(template)
  const plugins: SealedPluginEnvelope = {
    rawPlan: plan as never,
    previewPlan: plan as never,
    rawPlanDigest: digestPluginPlan('raw', plan as never),
    previewPlanDigest: digestPluginPlan('preview', plan as never),
    pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
  }
  return sealCeremony({
    intents: [intent],
    template,
    policyEvidence: policy,
    simulation: buildSimulationCertificate({ template, templateDigest, observedAt: 10, projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [] } }),
    plugins,
    validity: { createdAt: 10, expiresAt: 9_000, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy')) },
    presentationKind: 'supply',
    presentationInputs: { amount: '10', symbol: 'USDC' },
  })
}

export const artifactFor = (ceremony: SealedCeremony): FinalizedArtifact => ({
  __finalizedArtifact: true,
  ceremonyId: ceremony.ceremonyId,
  templateDigest: ceremony.templateDigest,
  transport: ceremony.template.transport,
  requests: ceremony.template.requests,
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

export const digestForCeremonyRequests = (ceremony: SealedCeremony): Hash =>
  keccak256(toHex(JSON.stringify(ceremony.template.requests, (_key, value) => typeof value === 'bigint' ? value.toString() : value)))
