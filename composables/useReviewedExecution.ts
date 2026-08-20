import { useConfig } from '@wagmi/vue'
import { getAccount as getWagmiAccount, sendCalls, sendTransaction } from '@wagmi/vue/actions'
import { getAddress, type Address, type Hash, type Hex, type StateOverride } from 'viem'
import type { Account, IHasVaultAddress, Permit2DataToSign, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { getSafeWalletProvider, isSafeConnectorIdentity } from '~/utils/safeWalletTransactions'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '~/features/reviewed-execution/domain/canonical'
import { connectorSessionDigest } from '~/features/reviewed-execution/domain/wallet-session'
import type { ReviewedExecution, WalletBinding, EoaRequest, SafeCall, SignatureSlot } from '~/features/reviewed-execution/domain/reviewed-execution'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { validateIntentSet } from '~/features/reviewed-execution/domain/validators'
import { rewardClaimId, rewardClaimSetDigest } from '~/features/reviewed-execution/domain/rewards'
import { PreparationCache, GenerationPublisher } from '~/features/reviewed-execution/planning/cache'
import { PlanningSnapshotLoader } from '~/features/reviewed-execution/planning/snapshot-loader'
import { createAppSnapshotDependencies, assertRuntimeAccountContext } from '~/features/reviewed-execution/planning/app-snapshot'
import { createLiteIntentCompilerRegistry, asCompilerRuntime, type LiteCompilerRuntime } from '~/features/reviewed-execution/planning/lite-compilers'
import { ReviewedExecutionPreparationService } from '~/features/reviewed-execution/planning/service'
import { collectPythPreviewData, rehydratePluginPrefetch, serializePluginPrefetch } from '~/features/reviewed-execution/planning/plugin-data'
import { PYTH_FRESHNESS_POLICY, PYTH_MAX_UPDATE_FEE } from '~/features/reviewed-execution/planning/plugin-config'
import { assertPermit2NonceCurrent, preparePermit2Slots, type PreparedMigrationSignatureSlot } from '~/features/reviewed-execution/materialization/signature-slots'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { assertPolicyVersionsMatch } from '~/features/reviewed-execution/policy/engine'
import type { EulerSimulationProjection } from '~/features/reviewed-execution/simulation/coverage'
import { collectPlanningRequirements, intentSetDigest } from '~/features/reviewed-execution/planning/requirements'
import { MutableExecutionEmergencySwitch } from '~/features/reviewed-execution/coordinator/emergency-switch'
import { assertExactWalletBinding, ReviewedExecutionCoordinator, type SubmissionResult } from '~/features/reviewed-execution/coordinator/coordinator'
import { IndexedDbSubmissionJournal } from '~/features/reviewed-execution/persistence/journal'
import { EoaExecutionAdapter } from '~/features/reviewed-execution/adapters/eoa'
import { SafeExecutionAdapter } from '~/features/reviewed-execution/adapters/safe'
import { createAppEoaClients, createAppSafeClients } from '~/features/reviewed-execution/adapters/app-clients'
import { finalizeReviewedRequestSet } from '~/features/reviewed-execution/materialization/finalize'
import { verifyRefreshedPluginPlan } from '~/features/reviewed-execution/materialization/pyth-refresh'
import { SubmissionRecoveryService } from '~/features/reviewed-execution/coordinator/recovery'
import { EoaAttemptReconciler, SafeAttemptReconciler } from '~/features/reviewed-execution/coordinator/reconcilers'
import type { WalletProviderLike } from '~/utils/safeWalletTransactions'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { readPreviewCache, readMigrationPreviewCache } from '~/features/reviewed-execution/planning/preview-cache'
import { compileCrossProtocolMigrationIntent, type MigrationCompilerSdk } from '~/features/reviewed-execution/planning/migration-compiler'
import type { AdditionalMaterializedCall } from '~/features/reviewed-execution/materialization/prepared-plan'
import { projectEulerSimulation } from '~/features/reviewed-execution/simulation/euler-projection'

const COMPILER_VERSION = 'lite-reviewed-execution-v2'
const CLASSIFICATION_VERSION = 'safe-classification-v2'
const POLICY_VERSION = 'lite-policy-v2'
const REVIEW_TTL_MS = 60_000

const PERMIT2_ALLOWANCE_ABI = [{
  type: 'function',
  name: 'allowance',
  stateMutability: 'view',
  inputs: [
    { name: 'user', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'spender', type: 'address' },
  ],
  outputs: [
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
}] as const

interface ConnectorSessionLike {
  topic?: string
  pairingTopic?: string
  peer?: { metadata?: { name?: string, url?: string } }
}

interface ProviderWithSession {
  session?: ConnectorSessionLike
}

export interface PrepareReviewedExecutionOptions {
  presentationKind: string
  presentationInputs: unknown
  cartGeneration?: number
  generation?: GenerationPublisher
}

export interface PreparedExecutionReview {
  execution: Readonly<ReviewedExecution>
  previewPlan: TransactionPlan
  prepared: TransactionPlanPrepared
}

const cache = new PreparationCache()
const emergencySwitch = new MutableExecutionEmergencySwitch()
const executions = new Map<Hash, Readonly<ReviewedExecution>>()
const reviewGenerations = new Map<Hash, { publisher: GenerationPublisher, generation: number }>()
let journalPromise: Promise<IndexedDbSubmissionJournal> | undefined

const getJournal = () => journalPromise ??= IndexedDbSubmissionJournal.open()

const currentPolicyVersionDigest = () => canonicalDigest('policy-version-v1', toCanonicalValue({
  version: POLICY_VERSION,
  labels: getEulerLabelsVersion(),
}))

export const canonicalReviewPresentation = (value: unknown, path = '$'): CanonicalValue => {
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isSafeInteger(value)) return value.toString()
  if (Array.isArray(value)) return value.map((entry, index) => canonicalReviewPresentation(entry, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    const result: Record<string, CanonicalValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === 'function' || key === 'onConfirm') continue
      result[key] = canonicalReviewPresentation(entry, `${path}.${key}`)
    }
    return result
  }
  return toCanonicalValue(value, path)
}

export const reviewPresentationCacheDigest = (kind: string, value: unknown): Hash =>
  canonicalDigest('review-presentation-v1', toCanonicalValue({
    kind,
    inputs: canonicalReviewPresentation(value),
  }))

const sessionIdFor = async (connector: NonNullable<ReturnType<typeof getWagmiAccount>['connector']>) => {
  const provider = connector.getProvider ? await connector.getProvider().catch(() => undefined) as ProviderWithSession | undefined : undefined
  const session = provider?.session
  return connectorSessionDigest({
    connectorId: connector.id,
    connectorName: connector.name,
    connectorType: connector.type,
    sessionTopic: session?.topic ?? '',
    pairingTopic: session?.pairingTopic ?? '',
    peerName: session?.peer?.metadata?.name ?? '',
    peerUrl: session?.peer?.metadata?.url ?? '',
  })
}

const captureWalletBinding = async (
  config: ReturnType<typeof useConfig>,
  signaturesEnabled: boolean,
): Promise<WalletBinding> => {
  const first = getWagmiAccount(config)
  if (!first.address || !first.chainId || !first.connector) throw new Error('Wallet is not connected')
  const account = getAddress(first.address)
  const connectorSessionId = await sessionIdFor(first.connector)
  const safeProvider = await getSafeWalletProvider(first.connector)
  const walletKind = safeProvider || isSafeConnectorIdentity(first.connector) ? 'safe' : 'eoa'
  if (walletKind === 'safe' && !safeProvider) throw new Error('Safe wallet provider is unavailable')
  const second = getWagmiAccount(config)
  if (!second.address || !second.chainId || !second.connector
    || getAddress(second.address) !== account
    || second.chainId !== first.chainId
    || second.connector.uid !== first.connector.uid
    || await sessionIdFor(second.connector) !== connectorSessionId) {
    throw new Error('Wallet context changed while classification was resolving')
  }
  return {
    chainId: first.chainId,
    account,
    subAccounts: [account],
    connectorId: first.connector.id,
    connectorSessionId,
    walletKind,
    ...(walletKind === 'safe' ? { safeAddress: account } : {}),
    classificationVersion: CLASSIFICATION_VERSION,
    approvalMode: walletKind === 'safe' || !signaturesEnabled ? 'approve' : 'permit2',
  }
}

const loadPlanningAccount = async (owner: Address, chainId: number): Promise<Account<IHasVaultAddress>> => {
  const warmed = useFreshAccount().account.value
  if (warmed) {
    try {
      assertRuntimeAccountContext(warmed, owner, chainId)
      return warmed
    }
    catch { /* a stale preloaded account snapshot is never adopted */ }
  }
  const sdk = await getEulerSdkFresh()
  const fetched = await sdk.accountService.fetchAccount(chainId, owner, {
    populateVaults: true,
    populateMarketPrices: false,
    populateUserRewards: true,
  })
  return fetched.result as Account<IHasVaultAddress>
}

const hydrateRequiredSubAccounts = async (
  sdk: Awaited<ReturnType<typeof getEulerSdkFresh>>,
  account: Account<IHasVaultAddress>,
  subAccounts: readonly Address[],
  preserveExisting = false,
) => {
  for (const subAccount of subAccounts) {
    const existing = account.getSubAccount(subAccount)
    if (preserveExisting && existing) continue
    const vaults = existing?.positions.map(position => getAddress(position.vaultAddress)) ?? []
    const fetched = await sdk.accountService.fetchSubAccount(account.chainId, subAccount, [...new Set(vaults)], {
      populateVaults: false,
      populateMarketPrices: false,
      populateUserRewards: false,
    })
    if (fetched.result) account.setSubAccount(fetched.result)
  }
}

export const useReviewedExecution = () => {
  const { rewards, buildClaimRewardPlan } = useSdkRewards()
  const { locks, buildUnlockREULPlan } = useREULLocks()
  const config = useConfig()
  const { signaturesEnabled } = useSignaturePreference()
  const { triggerPortfolioRefresh } = usePortfolioRefresh()

  const prepare = async (intents: readonly OperationIntent[], options: PrepareReviewedExecutionOptions): Promise<PreparedExecutionReview> => {
    if (emergencySwitch.isNewReviewDisabled()) throw new Error(emergencySwitch.reason() ?? 'New transaction reviewed executions are disabled')
    validateIntentSet(intents)
    const publisher = options.generation ?? new GenerationPublisher()
    const cartGeneration = options.cartGeneration ?? publisher.advance()
    if (options.cartGeneration !== undefined) publisher.assertCurrent(cartGeneration)
    const captured = await captureWalletBinding(config, signaturesEnabled.value)
    publisher.assertCurrent(cartGeneration)
    const requirements = collectPlanningRequirements(intents)
    if (requirements.chainId !== captured.chainId || requirements.owner !== captured.account) throw new Error('Intent context does not match the connected wallet')
    const wallet: WalletBinding = { ...captured, subAccounts: requirements.accounts }
    const assertPreparationContext = async () => {
      publisher.assertCurrent(cartGeneration)
      const current = await captureWalletBinding(config, signaturesEnabled.value)
      publisher.assertCurrent(cartGeneration)
      assertExactWalletBinding(wallet, { ...current, subAccounts: wallet.subAccounts })
    }
    const sdk = await getEulerSdkFresh()
    if (typeof (sdk.executionService as { materializeExecution?: unknown }).materializeExecution !== 'function') {
      throw new Error('SDK deterministic execution materialization is unavailable')
    }
    await assertPreparationContext()
    const account = await loadPlanningAccount(wallet.account, wallet.chainId)
    await assertPreparationContext()
    await hydrateRequiredSubAccounts(sdk, account, requirements.accounts)
    await assertPreparationContext()
    assertRuntimeAccountContext(account, wallet.account, wallet.chainId)

    const directCallAllowlist: Record<string, string> = {}
    const migrationSlots: PreparedMigrationSignatureSlot[] = []
    const migrationBefore: AdditionalMaterializedCall[] = []
    const migrationAfter: AdditionalMaterializedCall[] = []
    const migrationStateOverrides: StateOverride = []
    const runtime: LiteCompilerRuntime = {
      account,
      sdk,
      async compileRewardClaim(intent) {
        const args = intent.planner.args
        const claimIds = args.claimIds as unknown as readonly string[]
        const selected = rewards.value.filter(reward => claimIds.includes(rewardClaimId(reward)))
        if (selected.length !== claimIds.length || rewardClaimSetDigest(selected) !== args.rewardsDigest) throw new Error('Selected reward evidence changed before sealing')
        const plans = await Promise.all(selected.map(buildClaimRewardPlan))
        const plan = sdk.executionService.mergePlans(plans)
        for (const item of plan) {
          if (item.type === 'contractCall' && !(item as typeof item & { simulationMode?: string }).simulationMode) {
            directCallAllowlist[`${item.chainId}:${getAddress(item.to).toLowerCase()}:${item.functionName}`] = `reward:${args.provider}`
          }
        }
        return plan
      },
      async compileREULUnlock(intent) {
        const timestamps = intent.planner.args.lockTimestamps as unknown as readonly number[]
        const amounts = intent.planner.args.lockAmounts as unknown as readonly bigint[]
        const selected = timestamps.map((timestamp, index) => {
          const lock = locks.value.find(candidate => candidate.timestamp === BigInt(timestamp))
          if (!lock || lock.amount !== amounts[index]) throw new Error('rEUL lock evidence changed before sealing')
          return lock
        })
        if (selected.length !== timestamps.length) throw new Error('rEUL lock selection changed')
        return buildUnlockREULPlan(timestamps.map(BigInt))
      },
      async compileCrossProtocolMigration(intent, context) {
        return compileCrossProtocolMigrationIntent({
          intent,
          account,
          sdk: sdk as unknown as MigrationCompilerSdk,
          collectors: {
            migrationSlots,
            before: migrationBefore,
            after: migrationAfter,
            stateOverrides: migrationStateOverrides,
          },
          warmedResult: readMigrationPreviewCache(intent, context.snapshot.observedBlock),
        })
      },
    }
    const provider = sdk.providerService.getProvider(wallet.chainId)
    const snapshotLoader = new PlanningSnapshotLoader(cache, createAppSnapshotDependencies({
      account,
      getBlockNumber: () => provider.getBlockNumber(),
      dataVersion: COMPILER_VERSION,
      labelsVersion: String(getEulerLabelsVersion()),
    }), publisher, COMPILER_VERSION)
    const compiler = createLiteIntentCompilerRegistry(sdk)
    const presentationInputs = canonicalReviewPresentation(options.presentationInputs)
    const service = new ReviewedExecutionPreparationService({
      compiler,
      snapshotLoader,
      materializationSdk: sdk,
      async prefetchPlugins(plan, binding) {
        const previewCache = readPreviewCache({
          intents,
          rawPlan: plan,
          owner: binding.account,
          chainId: binding.chainId,
          usePermit2: binding.approvalMode === 'permit2',
          unlimitedApproval: false,
          allowSimulation: false,
        })
        if (previewCache.pluginPrefetch !== undefined) return previewCache.pluginPrefetch
        return serializePluginPrefetch(await sdk.executionService.prefetchPluginDataForPlan(plan, account, binding.chainId))
      },
      async processPlugins(plan, binding, prefetched) {
        return sdk.executionService.processPlanPlugins(plan, account, binding.chainId, rehydratePluginPrefetch(prefetched))
      },
      async resolveApprovals(plan, binding) {
        return sdk.executionService.resolveRequiredApprovals({
          plan,
          chainId: binding.chainId,
          account: binding.account,
          usePermit2: binding.approvalMode === 'permit2',
        })
      },
      async preparePermit2Slots(plan, binding) {
        const permit2 = getAddress(sdk.deploymentService.getDeployment(binding.chainId).addresses.coreAddrs.permit2)
        return preparePermit2Slots({
          plan,
          chainId: binding.chainId,
          sdk,
          readNonce: async (approval: Permit2DataToSign) => {
            const result = await provider.readContract({
              address: permit2,
              abi: PERMIT2_ALLOWANCE_ABI,
              functionName: 'allowance',
              args: [approval.owner, approval.token, approval.spender],
              authorizationList: undefined,
            })
            return Number(result[2])
          },
        })
      },
      async prepareMigrationSignatureSlots() {
        return migrationSlots
      },
      async collectPythEvidence(plan, _binding, _snapshot, prefetched) {
        return collectPythPreviewData(plan, prefetched)
      },
      resolvePolicy: requestSet => resolveAppPolicy(requestSet),
      async simulate(plan, requestSet, _snapshot, rawPlan) {
        const stateCovered = requestSet.effects.some(node => node.simulation.kind === 'evc-state' || node.simulation.kind === 'independent-call')
        if (!stateCovered) return undefined
        const previewCache = readPreviewCache({
          intents,
          rawPlan,
          preparedPlan: plan,
          owner: wallet.account,
          chainId: wallet.chainId,
          usePermit2: wallet.approvalMode === 'permit2',
          unlimitedApproval: false,
          allowSimulation: !requestSet.signatureSlots.some(slot => slot.kind === 'migration')
            && !migrationBefore.length
            && !migrationAfter.length
            && !migrationStateOverrides.length,
        })
        if (previewCache.simulationProjection !== undefined) {
          return previewCache.simulationProjection as unknown as EulerSimulationProjection
        }
        const prepared: TransactionPlanPrepared = {
          __prepared: true,
          plan,
          chainId: wallet.chainId,
          account,
          usePermit2: wallet.approvalMode === 'permit2',
          unlimitedApproval: false,
        }
        const result = await sdk.executionService.simulatePreparedTransactionPlan(prepared, {
          stateOverrides: true,
          ...(migrationStateOverrides.length ? { extraStateOverrides: migrationStateOverrides } : {}),
        })
        return projectEulerSimulation(result)
      },
      pluginConfiguration: toCanonicalValue({
        sdkPlugins: ['tos', 'keyring', 'pyth'],
        pyth: { maxUpdateFee: PYTH_MAX_UPDATE_FEE, freshness: PYTH_FRESHNESS_POLICY.maximumAgeSeconds },
      }),
      directCallAllowlist,
    }, cache, publisher)
    const policyVersionDigest = currentPolicyVersionDigest()
    const execution = await service.prepare({
      intents,
      wallet,
      cartGeneration,
      runtime: asCompilerRuntime(runtime),
      presentationKind: options.presentationKind,
      presentationInputs,
      compilerVersion: COMPILER_VERSION,
      policyVersionDigest,
      freshUntil: Date.now() + REVIEW_TTL_MS,
      before: migrationBefore,
      after: migrationAfter,
      assertContext: assertPreparationContext,
    })
    executions.set(execution.reviewId, execution)
    reviewGenerations.set(execution.reviewId, { publisher, generation: cartGeneration })
    const previewPlan = execution.pluginSnapshot.previewPlan as unknown as TransactionPlan
    return {
      execution,
      previewPlan,
      prepared: {
        __prepared: true,
        plan: previewPlan,
        chainId: wallet.chainId,
        account,
        usePermit2: wallet.approvalMode === 'permit2',
        unlimitedApproval: false,
      },
    }
  }

  const getReviewedExecution = (reviewId: Hash) => executions.get(reviewId)

  /**
   * Compile a non-authoritative preview for form and cart projections.
   * The preview remains outside the draft DTO and is always recompiled or
   * deep-validated by prepare() before review.
   */
  const compilePreview = async (
    intents: readonly OperationIntent[],
    providedAccount?: Account<IHasVaultAddress>,
  ): Promise<TransactionPlan> => {
    validateIntentSet(intents)
    const requirements = collectPlanningRequirements(intents)
    const sdk = await getEulerSdkFresh()
    const account = providedAccount ?? await loadPlanningAccount(requirements.owner, requirements.chainId)
    assertRuntimeAccountContext(account, requirements.owner, requirements.chainId)
    await hydrateRequiredSubAccounts(sdk, account, requirements.accounts, providedAccount !== undefined)
    const migrationSlots: PreparedMigrationSignatureSlot[] = []
    const migrationBefore: AdditionalMaterializedCall[] = []
    const migrationAfter: AdditionalMaterializedCall[] = []
    const migrationStateOverrides: StateOverride = []
    const runtime: LiteCompilerRuntime = {
      account,
      sdk,
      async compileRewardClaim(intent) {
        const claimIds = intent.planner.args.claimIds as unknown as readonly string[]
        const selected = rewards.value.filter(reward => claimIds.includes(rewardClaimId(reward)))
        if (selected.length !== claimIds.length || rewardClaimSetDigest(selected) !== intent.planner.args.rewardsDigest) {
          throw new Error('Selected reward evidence changed during preview preparation')
        }
        return sdk.executionService.mergePlans(await Promise.all(selected.map(buildClaimRewardPlan)))
      },
      async compileREULUnlock(intent) {
        const timestamps = intent.planner.args.lockTimestamps as unknown as readonly number[]
        return buildUnlockREULPlan(timestamps.map(BigInt))
      },
      async compileCrossProtocolMigration(intent, context) {
        return compileCrossProtocolMigrationIntent({
          intent,
          account,
          sdk: sdk as unknown as MigrationCompilerSdk,
          collectors: {
            migrationSlots,
            before: migrationBefore,
            after: migrationAfter,
            stateOverrides: migrationStateOverrides,
          },
          warmedResult: readMigrationPreviewCache(intent, context.snapshot.observedBlock),
        })
      },
    }
    const observedBlock = await sdk.providerService.getProvider(requirements.chainId).getBlockNumber()
    const body = {
      schemaVersion: 1 as const,
      intentSetHash: intentSetDigest(intents),
      owner: requirements.owner,
      chainId: requirements.chainId,
      observedBlock,
      dataSourceVersions: { preview: COMPILER_VERSION },
      records: {},
    }
    const snapshot = {
      ...body,
      digest: canonicalDigest('planning-snapshot-v1', toCanonicalValue(body)),
    }
    const compiled = await createLiteIntentCompilerRegistry(sdk).compile(
      intents,
      { snapshot, runtime: asCompilerRuntime(runtime) },
      () => {},
    )
    return compiled.plan
  }

  const executionRuntime = async (execution: ReviewedExecution) => {
    const journal = await getJournal()
    const sdk = await getEulerSdkFresh()
    const publicClient = sdk.providerService.getProvider(execution.requestSet.wallet.chainId)
    const evcAddress = getAddress(sdk.deploymentService.getDeployment(execution.requestSet.wallet.chainId).addresses.coreAddrs.evc)
    const connected = getWagmiAccount(config)
    const connector = connected.connector
    const safeProvider = connector ? await getSafeWalletProvider(connector) : undefined
    const eoa = createAppEoaClients({
      publicClient: publicClient as never,
      send: async (request: EoaRequest) => sendTransaction(config, {
        account: request.from,
        chainId: request.chainId,
        ...(connector ? { connector } : {}),
        to: request.to,
        data: request.data,
        value: request.value,
      }) as Promise<Hash>,
    })
    const unavailableSafeProvider: WalletProviderLike = {
      request: async () => { throw new Error('The reviewed Safe connector session is unavailable') },
    }
    const safe = createAppSafeClients({
      provider: safeProvider ?? unavailableSafeProvider,
      publicClient: publicClient as never,
      send: async (calls: readonly SafeCall[]) => {
        if (!connector || !safeProvider) throw new Error('The reviewed Safe connector session is unavailable')
        const result = await sendCalls(config, {
          account: execution.requestSet.wallet.account,
          chainId: execution.requestSet.wallet.chainId,
          connector,
          forceAtomic: true,
          calls: calls.map(call => ({ to: call.to, data: call.data, value: call.value })),
        })
        return result.id
      },
    })
    const coordinator = new ReviewedExecutionCoordinator({
      journal,
      emergencySwitch,
      adapters: {
        eoa: new EoaExecutionAdapter(
          eoa.adapter,
          (execution, options) => sdk.executionService.executeMaterialized(execution, options),
          evcAddress,
        ),
        safe: new SafeExecutionAdapter(safe.adapter),
      },
      async readWalletBinding() {
        const current = await captureWalletBinding(config, signaturesEnabled.value)
        return { ...current, subAccounts: execution.requestSet.wallet.subAccounts }
      },
      async revalidatePolicy(current) {
        if (current.validity.policyVersionDigest !== currentPolicyVersionDigest()) {
          throw new Error('Policy configuration or labels version changed after review')
        }
        const policy = await resolveAppPolicy(current.requestSet)
        assertPolicyVersionsMatch(current.policy, policy)
        const permit2 = getAddress(sdk.deploymentService.getDeployment(current.requestSet.wallet.chainId).addresses.coreAddrs.permit2)
        for (const slot of current.requestSet.signatureSlots.filter(candidate => candidate.kind === 'permit2')) {
          await assertPermit2NonceCurrent(slot, async (coordinate) => {
            if (coordinate.permit2 !== permit2) throw new Error('Permit2 deployment changed after review')
            const effect = current.requestSet.effects.find(candidate => candidate.effectId === slot.insertionPoints[0]?.effectId)
            if (!effect || effect.effect.kind !== 'approval' || effect.effect.mode !== 'permit2'
              || effect.effect.owner !== coordinate.owner || effect.effect.token !== coordinate.token || effect.effect.spender !== coordinate.spender) {
              throw new Error('Permit2 typed data does not match its reviewed approval effect')
            }
            const allowance = await publicClient.readContract({
              address: permit2,
              abi: PERMIT2_ALLOWANCE_ABI,
              functionName: 'allowance',
              args: [coordinate.owner, coordinate.token, coordinate.spender],
              authorizationList: undefined,
            })
            return BigInt(allowance[2])
          })
        }
      },
      async collectSignature(slot: SignatureSlot) {
        const current = getWagmiAccount(config)
        if (!current.connector) throw new Error('Wallet connector is unavailable')
        const provider = await current.connector.getProvider()
        if (!provider || typeof provider !== 'object' || !('request' in provider) || typeof provider.request !== 'function') {
          throw new Error('Wallet provider cannot sign typed data')
        }
        const signature = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [slot.signer, JSON.stringify(slot.typedData, (_key, value) => typeof value === 'bigint' ? value.toString() : value)],
        })
        if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) throw new Error('Wallet returned an invalid signature')
        return signature as Hex
      },
      async refreshPyth(current) {
        if (!current.requestSet.pythRefreshSlots.length) return []
        const raw = current.pluginSnapshot.rawPlan as unknown as TransactionPlan
        const sealedPreview = current.pluginSnapshot.previewPlan as unknown as TransactionPlan
        const prefetch = await sdk.executionService.prefetchPluginDataForPlan(raw, current.requestSet.wallet.account, current.requestSet.wallet.chainId)
        const serialized = serializePluginPrefetch(prefetch)
        const refreshed = await sdk.executionService.processPlanPlugins(raw, current.requestSet.wallet.account, current.requestSet.wallet.chainId, prefetch)
        const evidence = collectPythPreviewData(refreshed, serialized)
        return verifyRefreshedPluginPlan({
          sealedPreview,
          refreshed,
          slots: current.requestSet.pythRefreshSlots,
          evidence,
          nowSeconds: Math.floor(Date.now() / 1000),
        })
      },
      finalize(current, signatures, pythValues) {
        return finalizeReviewedRequestSet({
          reviewId: current.reviewId,
          requestDigest: current.requestDigest,
          requestSet: current.requestSet,
          sdk,
          signatures,
          pythValues,
        })
      },
    })
    const recovery = new SubmissionRecoveryService(journal, {
      eoa: new EoaAttemptReconciler(journal, eoa.recovery),
      safe: new SafeAttemptReconciler(journal, safe.recovery),
    })
    return { coordinator, recovery }
  }

  const accept = async (reviewId: Hash, reviewDigest: Hash): Promise<SubmissionResult> => {
    const generation = reviewGenerations.get(reviewId)
    generation?.publisher.assertCurrent(generation.generation)
    const memoryExecution = executions.get(reviewId)
    const execution = memoryExecution ?? await (await getJournal()).getReviewedExecution(reviewId)
    if (!execution) throw new Error('Reviewed execution is unavailable')
    const { coordinator } = await executionRuntime(execution)
    const result = await coordinator.execute(execution, { reviewId, reviewDigest })
    void invalidateSdkQueries([...INVALIDATE_AFTER_TX])
    triggerPortfolioRefresh()
    return result
  }

  const resume = async (attemptId: string) => {
    const attempt = await (await getJournal()).getAttempt(attemptId)
    if (!attempt) throw new Error('Attempt is unavailable')
    const execution = await (await getJournal()).getReviewedExecution(attempt.reviewId)
    if (!execution) throw new Error('Attempt reviewed execution is unavailable')
    return (await executionRuntime(execution)).coordinator.resume(attemptId)
  }

  const reconcile = async (attemptId: string) => {
    const attempt = await (await getJournal()).getAttempt(attemptId)
    if (!attempt) throw new Error('Attempt is unavailable')
    const execution = await (await getJournal()).getReviewedExecution(attempt.reviewId)
    if (!execution) throw new Error('Attempt reviewed execution is unavailable')
    return (await executionRuntime(execution)).recovery.reconcile(attemptId)
  }

  if (import.meta.client) {
    useReviewedExecutionRecovery().registerReconciler(async (attemptId) => {
      await reconcile(attemptId)
    })
  }

  return {
    prepare,
    compilePreview,
    accept,
    resume,
    reconcile,
    getReviewedExecution,
    emergencySwitch,
  }
}
