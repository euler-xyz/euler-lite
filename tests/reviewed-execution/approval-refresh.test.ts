import { Account, ExecutionService, WalletService, createPythPlugin, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, getAddress, keccak256, maxUint256, toHex, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVC_ABI } from '~/abis/evc'
import { PYTH_ABI } from '~/abis/pyth'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import type { WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import { assertPluginPlanBundleIntegrity } from '~/features/reviewed-execution/domain/seal'
import { finalizeReviewedRequestSet } from '~/features/reviewed-execution/materialization/finalize'
import { verifyRefreshedPluginPlan } from '~/features/reviewed-execution/materialization/pyth-refresh'
import { preparePermit2Slots } from '~/features/reviewed-execution/materialization/signature-slots'
import { GenerationPublisher, PreparationCache } from '~/features/reviewed-execution/planning/cache'
import { createLiteIntentCompilerRegistry } from '~/features/reviewed-execution/planning/lite-compilers'
import { collectPythPreviewData, rehydratePluginPrefetch, serializePluginPrefetch } from '~/features/reviewed-execution/planning/plugin-data'
import { ReviewedExecutionPreparationService, type PrepareReviewedExecutionRequest } from '~/features/reviewed-execution/planning/service'
import { PlanningSnapshotLoader } from '~/features/reviewed-execution/planning/snapshot-loader'
import { buildReviewedPolicy, collectPolicyRequirements } from '~/features/reviewed-execution/policy/engine'

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const POSITION = getAddress('0x1000000000000000000000000000000000000001')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const COLLATERAL = getAddress('0x3000000000000000000000000000000000000000')
const DEBT = getAddress('0x4000000000000000000000000000000000000000')
const EVC = getAddress('0x5000000000000000000000000000000000000000')
const PERMIT2 = getAddress('0x6000000000000000000000000000000000000000')
const PYTH = getAddress('0x7000000000000000000000000000000000000000')
const USDT = getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7')
const FEED = keccak256(toHex('feed'))
const NOW = 1_800_000_000_000
const SECOND = NOW / 1000
const SIGNATURE: Hex = `0x${'11'.repeat(64)}1b`

const decodeBatch = (data: Hex) => {
  const decoded = decodeFunctionData({ abi: EVC_ABI, data })
  if (decoded.functionName !== 'batch') throw new Error('Expected an EVC batch')
  return decoded.args[0]
}

interface Scenario {
  name: string
  walletKind?: 'eoa' | 'safe'
  approvalMode?: 'approve' | 'permit2'
  allowance?: 'direct' | 'reset' | 'permit2-token' | 'permit2-vault' | 'permit2-expired'
  collateralAmount?: bigint
  resolvedTypes: string[]
}

const scenarios: Scenario[] = [
  { name: 'EOA direct approval', resolvedTypes: ['approve'] },
  { name: 'EOA sufficient direct allowance', allowance: 'direct', resolvedTypes: [] },
  { name: 'EOA USDT allowance reset', allowance: 'reset', resolvedTypes: ['approve', 'approve'] },
  { name: 'Safe direct approval', walletKind: 'safe', resolvedTypes: ['approve'] },
  { name: 'Safe sufficient direct allowance', walletKind: 'safe', allowance: 'direct', resolvedTypes: [] },
  { name: 'Safe USDT allowance reset', walletKind: 'safe', allowance: 'reset', resolvedTypes: ['approve', 'approve'] },
  { name: 'Permit2 approval and signature', approvalMode: 'permit2', resolvedTypes: ['approve', 'permit2'] },
  { name: 'Permit2 signature only', approvalMode: 'permit2', allowance: 'permit2-token', resolvedTypes: ['permit2'] },
  { name: 'Permit2 sufficient allowance', approvalMode: 'permit2', allowance: 'permit2-vault', resolvedTypes: [] },
  { name: 'Permit2 expired allowance', approvalMode: 'permit2', allowance: 'permit2-expired', resolvedTypes: ['permit2'] },
  { name: 'Permit2 with sufficient direct allowance', approvalMode: 'permit2', allowance: 'direct', resolvedTypes: [] },
  { name: 'no wallet collateral', collateralAmount: 0n, resolvedTypes: [] },
]

const createFixture = (scenario: Scenario, hasPyth: boolean) => {
  const { allowance, walletKind = 'eoa', approvalMode = 'approve', collateralAmount = 10n } = scenario
  const token = allowance === 'reset' ? USDT : TOKEN
  const deploymentService = { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC, permit2: PERMIT2 } } }) }
  const fetchWallet = vi.fn(async (chainId: number, account: Address) => ({
    result: {
      chainId,
      account,
      assets: [{
        account,
        asset: token,
        balance: 100n,
        allowances: { [COLLATERAL]: {
          assetForVault: allowance === 'direct' ? maxUint256 : allowance === 'reset' ? 1n : 0n,
          assetForPermit2: allowance?.startsWith('permit2-') ? maxUint256 : 0n,
          assetForVaultInPermit2: ['permit2-vault', 'permit2-expired'].includes(allowance) ? 100n : 0n,
          permit2ExpirationTime: SECOND + (allowance === 'permit2-expired' ? -1 : 3600),
          permit2Nonce: 7,
        } },
      }],
    },
    errors: [],
  }))
  const executionService = new ExecutionService(deploymentService as never, new WalletService({ fetchWallet }))
  const sdk = { deploymentService, executionService }
  const plugin = createPythPlugin()
  executionService.setPluginProcessor((plan, account, chainId, prefetch) =>
    plugin.processPlan!(plan, account, chainId, sdk as never, prefetch))
  const prefetched = (fresh = false) => serializePluginPrefetch({
    pyth: { entries: hasPyth
      ? [{
          pythAddress: PYTH,
          feedIds: [FEED],
          publishTimes: [SECOND - (fresh ? 1 : 10)],
          updates: [fresh ? '0xaabbcc' : '0x0102'],
          fee: fresh ? 4n : 2n,
        }]
      : [] },
  })
  const wallet: WalletBinding = {
    chainId: 1, account: OWNER, subAccounts: [OWNER, POSITION],
    connectorId: walletKind === 'safe' ? 'safe' : 'injected', connectorSessionId: 'session-1',
    walletKind, classificationVersion: 'v1', approvalMode,
    ...(walletKind === 'safe' ? { safeAddress: OWNER } : {}),
  }
  const account = new Account({ chainId: 1, owner: OWNER, subAccounts: {} })
  const intent: OperationIntent = {
    schemaVersion: 1, intentId: 'borrow-1', revision: 1, kind: 'borrow', chainId: 1, account: OWNER,
    subAccounts: [OWNER, POSITION],
    planner: { name: 'borrow', args: {
      vaultAddress: DEBT, assetAddress: TOKEN, amount: 5n, borrowAccount: POSITION,
      collateral: { vault: COLLATERAL, asset: token, amount: collateralAmount }, skipCleanup: true,
    } },
    constraints: [
      { kind: 'maximum-input', token: TOKEN, amount: 5n },
      { kind: 'maximum-input', token, amount: collateralAmount },
    ],
    metadata: { createdAt: NOW, source: 'test', operation: 'borrow' },
  }
  const cache = new PreparationCache()
  const generation = new GenerationPublisher()
  const snapshotLoader = new PlanningSnapshotLoader(cache, { load: async key => ({
    value: { key }, observedBlock: 100n, version: 'v1', freshUntil: NOW + 60_000,
  }) }, generation, 'compiler-v1')
  const compiler = createLiteIntentCompilerRegistry(sdk)
  const compile = vi.spyOn(compiler, 'compile')
  const prefetchPlugins = vi.fn(async () => prefetched())
  const simulate = vi.fn(async () => ({ canExecute: true, simulatedAccounts: [], simulatedVaults: [], blockNumber: 100n }))
  const service = new ReviewedExecutionPreparationService({
    compiler, snapshotLoader, materializationSdk: sdk,
    prefetchPlugins,
    processPlugins: (plan, binding, prefetch) => executionService.processPlanPlugins(plan, account, binding.chainId, rehydratePluginPrefetch(prefetch)),
    resolveApprovals: (plan, binding) => executionService.resolveRequiredApprovals({
      plan, chainId: binding.chainId, account: binding.account, usePermit2: binding.approvalMode === 'permit2',
    }),
    preparePermit2Slots: plan => preparePermit2Slots({ plan, chainId: 1, sdk, readNonce: async () => 7, nowSeconds: SECOND }),
    prepareMigrationSignatureSlots: async () => [],
    collectPythEvidence: async (plan, _wallet, _snapshot, prefetch) => collectPythPreviewData(plan, prefetch),
    resolvePolicy: async requestSet => buildReviewedPolicy({
      requestSet,
      results: collectPolicyRequirements(requestSet).map(requirement => ({
        ...requirement, result: { state: 'allowed', version: 'v1', observedAt: NOW, expiresAt: NOW + 60_000 },
      })),
      now: NOW,
    }),
    simulate,
    pluginConfiguration: { plugins: ['pyth'] },
  }, cache, generation, () => NOW)
  const request: PrepareReviewedExecutionRequest = {
    intents: [intent], wallet, cartGeneration: 0, runtime: { account, sdk },
    presentationKind: 'borrow', presentationInputs: { amount: '5' }, compilerVersion: 'compiler-v1',
    policyVersionDigest: keccak256(toHex('policy-v1')), freshUntil: NOW + 60_000,
    ...(walletKind === 'safe' ? { safeAtomicCapability: { status: 'supported' as const } } : {}),
  }
  return { service, request, sdk, prefetched, fetchWallet, simulate, prefetchPlugins, compile, collateralAmount }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe.each([true, false])('approval preparation with Pyth enabled=%s', (hasPyth) => {
  it.each(scenarios)('$name preserves raw plugin input and sealed approvals through finalization and adoption', async (scenario) => {
    const fixture = createFixture(scenario, hasPyth)
    const { service, request, sdk } = fixture
    const prepared = await service.prepare(request)
    const { execution, pluginPlans } = prepared
    const { requestSet } = execution
    const rawPlan = pluginPlans.rawPlan as unknown as TransactionPlan
    const previewPlan = pluginPlans.previewPlan as unknown as TransactionPlan
    const sealedBeforeRefresh = structuredClone(prepared)
    expect(requestSet.pythRefreshSlots).toHaveLength(hasPyth ? 1 : 0)
    assertPluginPlanBundleIntegrity(execution.pluginSnapshot, pluginPlans, hasPyth)

    // Replay the same frozen raw sidecar used by useReviewedExecution.refreshPyth.
    const prefetch = fixture.prefetched(true)
    const refreshed = hasPyth
      ? await sdk.executionService.processPlanPlugins(rawPlan, OWNER, 1, rehydratePluginPrefetch(prefetch))
      : rawPlan
    const pythValues = hasPyth
      ? verifyRefreshedPluginPlan({
          sealedPreview: previewPlan, refreshed, slots: requestSet.pythRefreshSlots,
          evidence: collectPythPreviewData(refreshed, prefetch), nowSeconds: SECOND,
        })
      : []

    const rawApproval = rawPlan.find(item => item.type === 'requiredApproval')
    const previewApproval = previewPlan.find(item => item.type === 'requiredApproval')
    const compiled = await fixture.compile.mock.results[0].value
    const compiledApproval = compiled.plan.find(item => item.type === 'requiredApproval')
    if (fixture.collateralAmount > 0n) {
      // The real SDK resolver mutates the compiled item retained by its plugin.
      expect(compiledApproval.resolved).toEqual(previewApproval.resolved)
      expect(previewApproval.resolved.map(item => item.type)).toEqual(scenario.resolvedTypes)
      expect(rawApproval).not.toBe(compiledApproval)
      expect(rawApproval).not.toHaveProperty('resolved')
      expect(Object.isFrozen(rawApproval)).toBe(true)
    }
    else {
      expect(rawApproval).toBeUndefined()
      expect(previewApproval).toBeUndefined()
    }
    expect(fixture.fetchWallet).toHaveBeenCalledTimes(fixture.collateralAmount > 0n ? 1 : 0)
    expect(requestSet.signatureSlots).toHaveLength(scenario.resolvedTypes.filter(type => type === 'permit2').length)
    const signatures = requestSet.signatureSlots.map(slot => ({ slotId: slot.slotId, signature: SIGNATURE }))
    const finalized = finalizeReviewedRequestSet({
      reviewId: execution.reviewId, requestDigest: execution.requestDigest, requestSet, sdk, signatures, pythValues,
    })
    for (const [index, sealed] of requestSet.requests.entries()) {
      const final = finalized.requests[index]
      if (sealed.to !== EVC) {
        expect(final).toEqual(sealed)
        continue
      }
      const reviewedItems = decodeBatch(sealed.data)
      const finalItems = decodeBatch(final.data)
      expect(final).toEqual({ ...sealed, data: final.data, value: sealed.value + (hasPyth ? 2n : 0n) })
      expect(finalItems).toHaveLength(reviewedItems.length)
      for (const [batchIndex, item] of reviewedItems.entries()) {
        if (item.targetContract === PYTH) {
          expect(finalItems[batchIndex]).toEqual({ ...item, data: pythValues[0].data, value: 4n })
          expect(decodeFunctionData({ abi: PYTH_ABI, data: finalItems[batchIndex].data }).args).toEqual([['0xaabbcc']])
        }
        else if (item.targetContract === PERMIT2) {
          const slot = requestSet.signatureSlots[0]
          expect(finalItems[batchIndex]).toEqual(sdk.executionService.encodePermit2Call({
            chainId: 1, owner: OWNER,
            message: slot.typedData.message as Parameters<typeof sdk.executionService.encodePermit2Call>[0]['message'],
            signature: SIGNATURE,
          }))
        }
        else expect(finalItems[batchIndex]).toEqual(item)
      }
    }
    expect(prepared).toEqual(sealedBeforeRefresh)
    assertPluginPlanBundleIntegrity(execution.pluginSnapshot, pluginPlans, hasPyth)

    const adopt = service.getAdoptionIdentity(execution.reviewId)
    expect(adopt).toBeDefined()
    expect(await service.prepare({ ...request, adopt })).toEqual(prepared)
    expect(fixture.prefetchPlugins).toHaveBeenCalledTimes(1)
    expect(fixture.simulate).toHaveBeenCalledTimes(1)
  })
})
