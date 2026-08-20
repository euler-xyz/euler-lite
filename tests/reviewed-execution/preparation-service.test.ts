import { encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { PolicyState, WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { IntentCompilerRegistry } from '~/features/reviewed-execution/planning/compiler'
import { GenerationPublisher, PreparationCache } from '~/features/reviewed-execution/planning/cache'
import { ReviewedExecutionPreparationService } from '~/features/reviewed-execution/planning/service'
import { PlanningSnapshotLoader } from '~/features/reviewed-execution/planning/snapshot-loader'
import { buildReviewedPolicy, collectPolicyRequirements } from '~/features/reviewed-execution/policy/engine'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const EVC = getAddress('0x4000000000000000000000000000000000000000')
const intent: OperationIntent = {
  schemaVersion: 1, intentId: 'intent-1', revision: 1, kind: 'deposit', chainId: 1, account: ACCOUNT,
  subAccounts: [ACCOUNT], planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 10n }], metadata: { createdAt: 1, source: 'test' },
}
const wallet: WalletBinding = {
  chainId: 1, account: ACCOUNT, subAccounts: [ACCOUNT], connectorId: 'injected', connectorSessionId: 'session-1',
  walletKind: 'eoa', classificationVersion: 'v1', approvalMode: 'approve',
}
const plan: TransactionPlan = [{ type: 'evcBatch', items: [{ targetContract: VAULT, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x12345678' }] }]
const allowed = (): PolicyState => ({ state: 'allowed', version: 'v1', observedAt: 1, expiresAt: 10_000 })

describe('authoritative reviewed execution preparation', () => {
  it('adopts exact warmed snapshots, plugin prefetch, simulation, and reviewed executions', async () => {
    const cache = new PreparationCache()
    const generation = new GenerationPublisher()
    const dependencyLoad = vi.fn(async (key: string) => ({ value: { key }, observedBlock: 100n, version: 'v1', freshUntil: 5_000 }))
    const compilerCall = vi.fn(async () => plan)
    const pluginPrefetch = vi.fn(async () => ({ pyth: [], keyring: [] }))
    const simulation = vi.fn(async () => ({ canExecute: true, simulatedAccounts: [], simulatedVaults: [], blockNumber: 100n }))
    const snapshotLoader = new PlanningSnapshotLoader(cache, { load: dependencyLoad }, generation, 'compiler-v1')
    const compiler = new IntentCompilerRegistry({ deposit: { compile: compilerCall } }, plans => plans.flat())
    const service = new ReviewedExecutionPreparationService({
      compiler,
      snapshotLoader,
      materializationSdk: {
        deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
        executionService: { encodeBatch: (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }) },
      },
      prefetchPlugins: pluginPrefetch,
      processPlugins: async current => current,
      resolveApprovals: async current => current,
      preparePermit2Slots: async () => [],
      prepareMigrationSignatureSlots: async () => [],
      collectPythEvidence: async () => [],
      resolvePolicy: async requestSet => buildReviewedPolicy({
        requestSet,
        results: collectPolicyRequirements(requestSet).map(requirement => ({ ...requirement, result: allowed() })),
        now: 100,
      }),
      simulate: simulation,
      pluginConfiguration: { pythMaxUpdateFee: 10n },
    }, cache, generation, () => 100)
    const request = {
      intents: [intent], wallet, cartGeneration: 0, runtime: {}, presentationKind: 'supply',
      presentationInputs: { amount: '10', symbol: 'USDC' }, compilerVersion: 'compiler-v1',
      policyVersionDigest: keccak256(toHex('policy-v1')), freshUntil: 5_000,
    } as const

    const execution = await service.prepare(request)
    const adoptionIdentity = service.getAdoptionIdentity(execution.reviewId)
    expect(adoptionIdentity).toBeDefined()
    const adopted = await service.prepare(request)
    expect(adopted.reviewId).toBe(execution.reviewId)
    expect(compilerCall).toHaveBeenCalledTimes(2)
    expect(pluginPrefetch).toHaveBeenCalledOnce()
    expect(simulation).toHaveBeenCalledOnce()
    expect(dependencyLoad).toHaveBeenCalled()
  })

  it('discards every result published after the cart generation advances', async () => {
    const cache = new PreparationCache()
    const generation = new GenerationPublisher()
    const snapshotLoader = new PlanningSnapshotLoader(cache, { load: async (key) => {
      generation.advance()
      return { value: { key }, observedBlock: 100n, version: 'v1', freshUntil: 5_000 }
    } }, generation, 'compiler-v1')
    const compiler = new IntentCompilerRegistry({ deposit: { compile: async () => plan } }, plans => plans.flat())
    const service = new ReviewedExecutionPreparationService({
      compiler, snapshotLoader,
      materializationSdk: { deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) }, executionService: { encodeBatch: () => '0x' } },
      prefetchPlugins: async () => ({}), processPlugins: async current => current, resolveApprovals: async current => current,
      preparePermit2Slots: async () => [], prepareMigrationSignatureSlots: async () => [], collectPythEvidence: async () => [],
      resolvePolicy: async () => { throw new Error('unreachable') }, simulate: async () => undefined, pluginConfiguration: {},
    }, cache, generation, () => 100)
    await expect(service.prepare({
      intents: [intent], wallet, cartGeneration: 0, runtime: {}, presentationKind: 'supply', presentationInputs: {},
      compilerVersion: 'compiler-v1', policyVersionDigest: keccak256(toHex('policy-v1')), freshUntil: 5_000,
    })).rejects.toThrow(/superseded generation/)
  })

  it('rejects mutable wallet context drift at asynchronous preparation boundaries', async () => {
    const cache = new PreparationCache()
    const generation = new GenerationPublisher()
    const compilerCall = vi.fn(async () => plan)
    const snapshotLoader = new PlanningSnapshotLoader(cache, { load: async key => ({
      value: { key }, observedBlock: 100n, version: 'v1', freshUntil: 5_000,
    }) }, generation, 'compiler-v1')
    const compiler = new IntentCompilerRegistry({ deposit: { compile: compilerCall } }, plans => plans.flat())
    let contextChecks = 0
    const service = new ReviewedExecutionPreparationService({
      compiler, snapshotLoader,
      materializationSdk: { deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) }, executionService: { encodeBatch: () => '0x' } },
      prefetchPlugins: async () => ({}), processPlugins: async current => current, resolveApprovals: async current => current,
      preparePermit2Slots: async () => [], prepareMigrationSignatureSlots: async () => [], collectPythEvidence: async () => [],
      resolvePolicy: async () => { throw new Error('unreachable') }, simulate: async () => undefined, pluginConfiguration: {},
    }, cache, generation, () => 100)

    await expect(service.prepare({
      intents: [intent], wallet, cartGeneration: 0, runtime: {}, presentationKind: 'supply', presentationInputs: {},
      compilerVersion: 'compiler-v1', policyVersionDigest: keccak256(toHex('policy-v1')), freshUntil: 5_000,
      assertContext: async () => {
        contextChecks++
        if (contextChecks > 1) throw new Error('wallet context changed')
      },
    })).rejects.toThrow(/wallet context changed/)
    expect(compilerCall).not.toHaveBeenCalled()
  })
})
