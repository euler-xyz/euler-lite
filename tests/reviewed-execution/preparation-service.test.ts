import { encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { PolicyState, WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { materializePreparedPlan } from '~/features/reviewed-execution/materialization/prepared-plan'
import { IntentCompilerRegistry } from '~/features/reviewed-execution/planning/compiler'
import { GenerationPublisher, PreparationCache } from '~/features/reviewed-execution/planning/cache'
import { ReviewedExecutionPreparationService, type ReviewedExecutionDependencies } from '~/features/reviewed-execution/planning/service'
import { PlanningSnapshotLoader } from '~/features/reviewed-execution/planning/snapshot-loader'
import { createAppSnapshotDependencies } from '~/features/reviewed-execution/planning/app-snapshot'
import { collectPlanningRequirements } from '~/features/reviewed-execution/planning/requirements'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { buildReviewedPolicy, collectPolicyRequirements } from '~/features/reviewed-execution/policy/engine'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { detectVpn } from '~/services/vpn'
import { screenAddress } from '~/services/screening'

vi.mock('~/services/vpn', () => ({ detectVpn: vi.fn(async () => false) }))
vi.mock('~/services/screening', () => ({ screenAddress: vi.fn(async () => false) }))
vi.mock('~/composables/useEulerLabels', () => ({ getEulerLabelsVersion: vi.fn(() => 1) }))

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const EVC = getAddress('0x4000000000000000000000000000000000000000')
const AAVE_POOL = getAddress('0x5000000000000000000000000000000000000000')
const POSITION_ACCOUNT = getAddress('0x6000000000000000000000000000000000000000')
const REUL = getAddress('0x7000000000000000000000000000000000000000')
const intent: OperationIntent = {
  schemaVersion: 1, intentId: 'intent-1', revision: 1, kind: 'deposit', chainId: 1, account: ACCOUNT,
  subAccounts: [ACCOUNT], planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 10n }], metadata: { createdAt: 1, source: 'test', operation: 'test' },
}
const wallet: WalletBinding = {
  chainId: 1, account: ACCOUNT, subAccounts: [ACCOUNT], connectorId: 'injected', connectorSessionId: 'session-1',
  walletKind: 'eoa', classificationVersion: 'v1', approvalMode: 'approve',
}
const plan: TransactionPlan = [{ type: 'evcBatch', items: [{ targetContract: VAULT, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x12345678' }] }]
const allowed = (): PolicyState => ({ state: 'allowed', version: 'v1', observedAt: 1, expiresAt: 10_000 })

let currentVault: { address: typeof VAULT, type?: string, asset?: { address?: typeof TOKEN, symbol?: string, decimals?: number } } | undefined

beforeEach(() => {
  currentVault = { address: VAULT, type: 'evault', asset: { address: TOKEN, symbol: 'TEST', decimals: 18 } }
  vi.mocked(getEulerLabelsVersion).mockReturnValue(1)
  vi.mocked(detectVpn).mockReset().mockResolvedValue(false)
  vi.mocked(screenAddress).mockReset().mockResolvedValue(false)
  vi.stubGlobal('useVaultRegistry', () => ({
    getVault: (address: string) => getAddress(address) === VAULT ? currentVault : undefined,
    isVerifiedVault: () => true,
  }))
  vi.stubGlobal('useTokenList', () => ({
    getTokenByAddress: (address: string) => getAddress(address) === TOKEN
      ? { address: TOKEN, symbol: 'TEST', name: 'Test token', decimals: 18 }
      : undefined,
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const createAppPolicyService = (plannerName: OperationIntent['planner']['name']) => {
  const cache = new PreparationCache()
  const generation = new GenerationPublisher()
  const snapshotLoader = new PlanningSnapshotLoader(cache, { load: async key => ({
    value: { key }, observedBlock: 100n, version: 'v1', freshUntil: 5_000,
  }) }, generation, 'compiler-v1')
  const compiler = new IntentCompilerRegistry({ [plannerName]: { compile: async () => plan } }, plans => plans.flat())
  return new ReviewedExecutionPreparationService({
    compiler,
    snapshotLoader,
    materializationSdk: {
      deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
      executionService: { encodeBatch: (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }) },
    },
    prefetchPlugins: async () => ({}),
    processPlugins: async current => current,
    resolveApprovals: async current => current,
    preparePermit2Slots: async () => [],
    prepareMigrationSignatureSlots: async () => [],
    collectPythEvidence: async () => [],
    resolvePolicy: requestSet => resolveAppPolicy(requestSet, 100),
    simulate: async () => ({ canExecute: true, simulatedAccounts: [], simulatedVaults: [], blockNumber: 100n }),
    pluginConfiguration: {},
  }, cache, generation, () => 100)
}

const aaveMigrationIntent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-aave-migration',
  revision: 1,
  kind: 'migration',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT, POSITION_ACCOUNT],
  planner: {
    name: 'cross-protocol-migration',
    args: {
      direction: 'euler-to-external',
      connectorId: 'aave',
      owner: ACCOUNT,
      positionRef: { collateralAsset: TOKEN, debtAsset: TOKEN, pool: AAVE_POOL },
      deadline: 1_000n,
      authorizationEvidenceDigest: keccak256(toHex('aave-authorization')),
    },
  },
  constraints: [
    { kind: 'maximum-input', token: TOKEN, amount: 10n },
    { kind: 'deadline', timestamp: 1_000 },
  ],
  metadata: { createdAt: 1, source: 'test', operation: 'test' },
}
const aaveWallet: WalletBinding = { ...wallet, subAccounts: [ACCOUNT, POSITION_ACCOUNT] }
const reulIntent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-reul-unlock',
  revision: 1,
  kind: 'reul-unlock',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  planner: {
    name: 'reul-unlock',
    args: { lockTimestamps: [1], lockAmounts: [10n], remainderLossMaximum: 0n },
  },
  constraints: [{ kind: 'remainder-loss', token: REUL, maximumLoss: 0n }],
  metadata: { createdAt: 1, source: 'test', operation: 'test' },
}

describe('authoritative reviewed execution preparation', () => {
  it('adopts exact warmed snapshots, plugin prefetch, simulation, and reviewed executions', async () => {
    const cache = new PreparationCache()
    const generation = new GenerationPublisher()
    const dependencyLoad = vi.fn(async (key: string) => ({ value: { key }, observedBlock: 100n, version: 'v1', freshUntil: 5_000 }))
    const compilerCall = vi.fn(async () => plan)
    const pluginPrefetch = vi.fn(async () => ({ pyth: [], keyring: [] }))
    const simulation = vi.fn(async (..._args: Parameters<ReviewedExecutionDependencies['simulate']>) => ({
      canExecute: true,
      simulatedAccounts: [],
      simulatedVaults: [],
      blockNumber: 100n,
    }))
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

    const { execution, pluginPlans } = await service.prepare(request)
    const adoptionIdentity = service.getAdoptionIdentity(execution.reviewId)
    expect(adoptionIdentity).toBeDefined()
    const adopted = await service.prepare(request)
    expect(adopted.execution.reviewId).toBe(execution.reviewId)
    expect(adopted.pluginPlans).toEqual(pluginPlans)
    expect(adopted.execution.pluginSnapshot).not.toHaveProperty('rawPlan')
    expect(adopted.execution.pluginSnapshot).not.toHaveProperty('previewPlan')
    expect(compilerCall).toHaveBeenCalledTimes(2)
    expect(pluginPrefetch).toHaveBeenCalledOnce()
    expect(simulation).toHaveBeenCalledOnce()
    expect(simulation.mock.calls[0]?.[4]).toEqual([{
      intentId: intent.intentId,
      intentRevision: intent.revision,
      plan,
    }])
    expect(simulation.mock.calls[0]?.[5]).toEqual({ pyth: [], keyring: [] })
    expect(dependencyLoad).toHaveBeenCalled()

    const batchExecution = await service.prepare({
      ...request,
      presentationKind: 'batch',
      presentationInputs: [{ id: intent.intentId, review: request.presentationInputs }],
    })
    expect(batchExecution.execution.requestDigest).toBe(execution.requestDigest)
    expect(batchExecution.execution.requestSet).toEqual(execution.requestSet)
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

  it.each([
    ['direct', 'migration', { type: 'migration' }],
    ['batch', 'batch', [{ id: aaveMigrationIntent.intentId, review: { type: 'migration' } }]],
  ] as const)('prepares and revalidates an Aave migration without transaction-time screening for %s review', async (_path, presentationKind, presentationInputs) => {
    const service = createAppPolicyService('cross-protocol-migration')
    const { execution } = await service.prepare({
      intents: [aaveMigrationIntent],
      wallet: aaveWallet,
      cartGeneration: 0,
      runtime: {},
      presentationKind,
      presentationInputs,
      compilerVersion: 'compiler-v1',
      policyVersionDigest: keccak256(toHex('policy-v1')),
      freshUntil: 5_000,
    })

    expect(execution.binding.presentationKind).toBe(presentationKind)
    expect(execution.policy.subjects).not.toContainEqual(expect.objectContaining({ value: AAVE_POOL }))
    expect(execution.validity).not.toHaveProperty('expiresAt')
    await expect(resolveAppPolicy(execution.requestSet, 200)).resolves.toBeDefined()
    expect(execution.policy.results).not.toContainEqual(expect.objectContaining({ concern: 'wallet-screening' }))
    expect(detectVpn).not.toHaveBeenCalled()
    expect(screenAddress).not.toHaveBeenCalled()
  })

  it('keeps real vault metadata failures fail closed', async () => {
    currentVault = { address: VAULT }
    const service = createAppPolicyService('deposit')

    await expect(service.prepare({
      intents: [intent],
      wallet,
      cartGeneration: 0,
      runtime: {},
      presentationKind: 'supply',
      presentationInputs: {},
      compilerVersion: 'compiler-v1',
      policyVersionDigest: keccak256(toHex('policy-v1')),
      freshUntil: 5_000,
    })).rejects.toThrow(`Vault metadata is incomplete for ${VAULT}`)
  })

  it('does not require Euler labels for a reviewed direct call with no vault subject', async () => {
    vi.mocked(getEulerLabelsVersion).mockReturnValue(0)
    const rewardIntent: OperationIntent = {
      schemaVersion: 1,
      intentId: 'intent-reward',
      revision: 1,
      kind: 'reward-claim',
      chainId: 1,
      account: ACCOUNT,
      subAccounts: [ACCOUNT],
      planner: {
        name: 'reward-claim',
        args: { claimIds: ['claim-1'], provider: 'test', rewardsDigest: keccak256(toHex('rewards')) },
      },
      constraints: [{ kind: 'selected-rewards', claimIds: ['claim-1'] }],
      metadata: { createdAt: 1, source: 'test', operation: 'test' },
    }
    const directPlan: TransactionPlan = [{
      type: 'contractCall',
      chainId: 1,
      to: AAVE_POOL,
      abi: [{ type: 'function', name: 'claim', inputs: [], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'claim',
      args: [],
      value: 0n,
    }]
    const requestSet = materializePreparedPlan({
      intents: [rewardIntent],
      plan: directPlan,
      wallet,
      sdk: { deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) }, executionService: { encodeBatch: () => '0x' } },
      directCallAllowlist: { [`1:${AAVE_POOL.toLowerCase()}:claim`]: 'reward:test' },
      policyDigest: keccak256(toHex('pending')),
    })

    await expect(resolveAppPolicy(requestSet, 100)).resolves.toMatchObject({ schemaVersion: 1 })
  })

  it.each([
    ['direct', 'reul-unlock', { type: 'reul-unlock' }],
    ['batch', 'batch', [{ id: reulIntent.intentId, review: { type: 'reul-unlock' } }]],
  ] as const)('prepares an rEUL unlock without optional token-list metadata for %s review', async (_path, presentationKind, presentationInputs) => {
    const service = createAppPolicyService('reul-unlock')

    const { execution } = await service.prepare({
      intents: [reulIntent],
      wallet,
      cartGeneration: 0,
      runtime: {},
      presentationKind,
      presentationInputs,
      compilerVersion: 'compiler-v1',
      policyVersionDigest: keccak256(toHex('policy-v1')),
      freshUntil: 5_000,
    })

    expect(execution.policy.subjects).toContainEqual({ kind: 'asset', value: REUL })
  })

  it('keeps an asset address in the planning snapshot when optional display metadata is unavailable', async () => {
    const dependencies = createAppSnapshotDependencies({
      account: {} as never,
      getBlockNumber: async () => 100n,
      dataVersion: 'compiler-v1',
      labelsVersion: 'labels-v1',
    })

    await expect(dependencies.load(`asset:${REUL}`, collectPlanningRequirements([reulIntent]))).resolves.toMatchObject({
      value: { address: REUL },
      observedBlock: 100n,
      version: 'compiler-v1',
    })
  })
})
