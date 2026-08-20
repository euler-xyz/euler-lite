import { useConfig } from '@wagmi/vue'
import { getAccount as getWagmiAccount, sendCalls, sendTransaction } from '@wagmi/vue/actions'
import { getAddress, type Address, type Hash, type Hex, type StateOverride } from 'viem'
import type { Account, IHasVaultAddress, Permit2DataToSign, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { getSafeWalletProvider, isSafeConnectorIdentity } from '~/utils/safeWalletTransactions'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '~/features/transaction-ceremony/domain/canonical'
import { connectorSessionDigest } from '~/features/transaction-ceremony/domain/wallet-session'
import type { SealedCeremony } from '~/features/transaction-ceremony/domain/ceremony'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import type { WalletBinding, EoaRequest, SafeCall, SignatureSlot } from '~/features/transaction-ceremony/domain/template'
import { validateIntentSet } from '~/features/transaction-ceremony/domain/validators'
import { rewardClaimId, rewardClaimSetDigest } from '~/features/transaction-ceremony/domain/rewards'
import { PreparationCache, GenerationPublisher } from '~/features/transaction-ceremony/planning/cache'
import { PlanningSnapshotLoader } from '~/features/transaction-ceremony/planning/snapshot-loader'
import { createAppSnapshotDependencies, assertRuntimeAccountContext } from '~/features/transaction-ceremony/planning/app-snapshot'
import { createLiteIntentCompilerRegistry, asCompilerRuntime, type LiteCompilerRuntime } from '~/features/transaction-ceremony/planning/lite-compilers'
import { TransactionCeremonyPreparationService } from '~/features/transaction-ceremony/planning/service'
import { collectPythPreviewEvidence, rehydratePluginPrefetch, serializePluginPrefetch } from '~/features/transaction-ceremony/planning/plugin-evidence'
import { PYTH_FRESHNESS_POLICY, PYTH_MAX_UPDATE_FEE } from '~/features/transaction-ceremony/planning/plugin-config'
import { assertPermit2NonceCurrent, preparePermit2Slots, type PreparedMigrationSignatureSlot } from '~/features/transaction-ceremony/materialization/signature-slots'
import { resolveAppPolicyEvidence } from '~/features/transaction-ceremony/policy/app-policy'
import { assertPolicyEvidenceVersionsMatch } from '~/features/transaction-ceremony/policy/engine'
import type { EulerSimulationProjection } from '~/features/transaction-ceremony/simulation/coverage'
import { collectPlanningRequirements, intentSetDigest } from '~/features/transaction-ceremony/planning/requirements'
import { MutableCeremonyEmergencySwitch } from '~/features/transaction-ceremony/coordinator/emergency-switch'
import { assertExactWalletBinding, TransactionCeremonyCoordinator, type CeremonyExecutionResult } from '~/features/transaction-ceremony/coordinator/coordinator'
import { IndexedDbCeremonyJournal } from '~/features/transaction-ceremony/persistence/journal'
import { EoaCeremonyAdapter } from '~/features/transaction-ceremony/adapters/eoa'
import { SafeCeremonyAdapter } from '~/features/transaction-ceremony/adapters/safe'
import { createAppEoaClients, createAppSafeClients } from '~/features/transaction-ceremony/adapters/app-clients'
import { finalizeExecutionTemplate } from '~/features/transaction-ceremony/materialization/finalize'
import { verifyRefreshedPluginPlan } from '~/features/transaction-ceremony/materialization/pyth-refresh'
import { CeremonyRecoveryService } from '~/features/transaction-ceremony/coordinator/recovery'
import { EoaAttemptReconciler, SafeAttemptReconciler } from '~/features/transaction-ceremony/coordinator/reconcilers'
import type { WalletProviderLike } from '~/utils/safeWalletTransactions'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { bindEagerPlanIntents, matchEagerAcceleration, matchEagerMigrationCompilation } from '~/features/transaction-ceremony/planning/eager-plan-intents'
import { compileCrossProtocolMigrationIntent, type MigrationCompilerSdk } from '~/features/transaction-ceremony/planning/migration-compiler'
import type { AdditionalMaterializedCall } from '~/features/transaction-ceremony/materialization/prepared-plan'
import { projectEulerSimulation } from '~/features/transaction-ceremony/simulation/euler-projection'

const COMPILER_VERSION = 'lite-transaction-ceremony-v2'
const CLASSIFICATION_VERSION = 'safe-classification-v2'
const POLICY_VERSION = 'lite-policy-v2'
const CEREMONY_TTL_MS = 60_000

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

export interface PrepareCeremonyOptions {
  presentationKind: string
  presentationInputs: unknown
  cartGeneration?: number
  generation?: GenerationPublisher
}

export interface PreparedCeremonyReview {
  ceremony: Readonly<SealedCeremony>
  previewPlan: TransactionPlan
  prepared: TransactionPlanPrepared
}

const cache = new PreparationCache()
const emergencySwitch = new MutableCeremonyEmergencySwitch()
const ceremonies = new Map<Hash, Readonly<SealedCeremony>>()
const ceremonyGenerations = new Map<Hash, { publisher: GenerationPublisher, generation: number }>()
let journalPromise: Promise<IndexedDbCeremonyJournal> | undefined

const getJournal = () => journalPromise ??= IndexedDbCeremonyJournal.open()

const currentPolicyVersionDigest = () => canonicalDigest('policy-version-v1', toCanonicalValue({
  version: POLICY_VERSION,
  labels: getEulerLabelsVersion(),
}))

export const canonicalCeremonyPresentation = (value: unknown, path = '$'): CanonicalValue => {
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isSafeInteger(value)) return value.toString()
  if (Array.isArray(value)) return value.map((entry, index) => canonicalCeremonyPresentation(entry, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    const result: Record<string, CanonicalValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === 'function' || key === 'onConfirm') continue
      result[key] = canonicalCeremonyPresentation(entry, `${path}.${key}`)
    }
    return result
  }
  return toCanonicalValue(value, path)
}

export const ceremonyPresentationCacheDigest = (kind: string, value: unknown): Hash =>
  canonicalDigest('review-presentation-v1', toCanonicalValue({
    kind,
    inputs: canonicalCeremonyPresentation(value),
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

const captureWalletBinding = async (): Promise<WalletBinding> => {
  const config = useConfig()
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
  const { signaturesEnabled } = useSignaturePreference()
  return {
    chainId: first.chainId,
    account,
    subAccounts: [account],
    connectorId: first.connector.id,
    connectorSessionId,
    walletKind,
    ...(walletKind === 'safe' ? { safeAddress: account } : {}),
    classificationVersion: CLASSIFICATION_VERSION,
    approvalMode: walletKind === 'safe' || !signaturesEnabled.value ? 'approve' : 'permit2',
  }
}

const loadPlanningAccount = async (owner: Address, chainId: number): Promise<Account<IHasVaultAddress>> => {
  const warmed = useFreshAccount().account.value
  if (warmed) {
    try {
      assertRuntimeAccountContext(warmed, owner, chainId)
      return warmed
    }
    catch { /* a stale eager snapshot is never adopted */ }
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

export const useTransactionCeremony = () => {
  const { rewards, buildClaimRewardPlan } = useSdkRewards()
  const { locks, buildUnlockREULPlan } = useREULLocks()
  const config = useConfig()
  const { triggerPortfolioRefresh } = usePortfolioRefresh()

  const prepare = async (intents: readonly OperationIntent[], options: PrepareCeremonyOptions): Promise<PreparedCeremonyReview> => {
    if (emergencySwitch.isNewCeremonyDisabled()) throw new Error(emergencySwitch.reason() ?? 'New transaction ceremonies are disabled')
    validateIntentSet(intents)
    const publisher = options.generation ?? new GenerationPublisher()
    const cartGeneration = options.cartGeneration ?? publisher.advance()
    if (options.cartGeneration !== undefined) publisher.assertCurrent(cartGeneration)
    const captured = await captureWalletBinding()
    publisher.assertCurrent(cartGeneration)
    const requirements = collectPlanningRequirements(intents)
    if (requirements.chainId !== captured.chainId || requirements.owner !== captured.account) throw new Error('Intent context does not match the connected wallet')
    const wallet: WalletBinding = { ...captured, subAccounts: requirements.accounts }
    const assertPreparationContext = async () => {
      publisher.assertCurrent(cartGeneration)
      const current = await captureWalletBinding()
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
          warmedResult: matchEagerMigrationCompilation(intent, context.snapshot.observedBlock),
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
    const presentationInputs = canonicalCeremonyPresentation(options.presentationInputs)
    const service = new TransactionCeremonyPreparationService({
      compiler,
      snapshotLoader,
      materializationSdk: sdk,
      async prefetchPlugins(plan, binding) {
        const eager = matchEagerAcceleration({
          intents,
          rawPlan: plan,
          owner: binding.account,
          chainId: binding.chainId,
          usePermit2: binding.approvalMode === 'permit2',
          unlimitedApproval: false,
          allowSimulation: false,
        })
        if (eager.pluginPrefetch !== undefined) return eager.pluginPrefetch
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
        return collectPythPreviewEvidence(plan, prefetched)
      },
      resolvePolicy: template => resolveAppPolicyEvidence(template),
      async simulate(plan, template, _snapshot, rawPlan) {
        const stateCovered = template.effects.some(node => node.simulation.kind === 'evc-state' || node.simulation.kind === 'independent-call')
        if (!stateCovered) return undefined
        const eager = matchEagerAcceleration({
          intents,
          rawPlan,
          preparedPlan: plan,
          owner: wallet.account,
          chainId: wallet.chainId,
          usePermit2: wallet.approvalMode === 'permit2',
          unlimitedApproval: false,
          allowSimulation: !template.signatureSlots.some(slot => slot.kind === 'migration')
            && !migrationBefore.length
            && !migrationAfter.length
            && !migrationStateOverrides.length,
        })
        if (eager.simulationProjection !== undefined) {
          return eager.simulationProjection as unknown as EulerSimulationProjection
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
    const ceremony = await service.prepare({
      intents,
      wallet,
      cartGeneration,
      runtime: asCompilerRuntime(runtime),
      presentationKind: options.presentationKind,
      presentationInputs,
      compilerVersion: COMPILER_VERSION,
      policyVersionDigest,
      freshUntil: Date.now() + CEREMONY_TTL_MS,
      before: migrationBefore,
      after: migrationAfter,
      assertContext: assertPreparationContext,
    })
    ceremonies.set(ceremony.ceremonyId, ceremony)
    ceremonyGenerations.set(ceremony.ceremonyId, { publisher, generation: cartGeneration })
    const previewPlan = ceremony.plugins.previewPlan as unknown as TransactionPlan
    return {
      ceremony,
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

  const getCeremony = (ceremonyId: Hash) => ceremonies.get(ceremonyId)

  /**
   * Compile a non-authoritative eager preview for form and cart projections.
   * The preview remains outside the draft DTO and is always recompiled or
   * deep-validated by prepare() before review.
   */
  const compileEager = async (
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
          throw new Error('Selected reward evidence changed during eager preparation')
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
          warmedResult: matchEagerMigrationCompilation(intent, context.snapshot.observedBlock),
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
      dataSourceVersions: { eager: COMPILER_VERSION },
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
    return bindEagerPlanIntents(compiled.plan, intents)
  }

  const executionRuntime = async (ceremony: SealedCeremony) => {
    const journal = await getJournal()
    const sdk = await getEulerSdkFresh()
    const publicClient = sdk.providerService.getProvider(ceremony.template.wallet.chainId)
    const evcAddress = getAddress(sdk.deploymentService.getDeployment(ceremony.template.wallet.chainId).addresses.coreAddrs.evc)
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
          account: ceremony.template.wallet.account,
          chainId: ceremony.template.wallet.chainId,
          connector,
          forceAtomic: true,
          calls: calls.map(call => ({ to: call.to, data: call.data, value: call.value })),
        })
        return result.id
      },
    })
    const coordinator = new TransactionCeremonyCoordinator({
      journal,
      emergencySwitch,
      adapters: {
        eoa: new EoaCeremonyAdapter(
          eoa.adapter,
          (execution, options) => sdk.executionService.executeMaterialized(execution, options),
          evcAddress,
        ),
        safe: new SafeCeremonyAdapter(safe.adapter),
      },
      async readWalletBinding() {
        const current = await captureWalletBinding()
        return { ...current, subAccounts: ceremony.template.wallet.subAccounts }
      },
      async revalidatePolicy(current) {
        if (current.validity.policyVersionDigest !== currentPolicyVersionDigest()) {
          throw new Error('Policy configuration or labels version changed after review')
        }
        const policyEvidence = await resolveAppPolicyEvidence(current.template)
        assertPolicyEvidenceVersionsMatch(current.policyEvidence, policyEvidence)
        const permit2 = getAddress(sdk.deploymentService.getDeployment(current.template.wallet.chainId).addresses.coreAddrs.permit2)
        for (const slot of current.template.signatureSlots.filter(candidate => candidate.kind === 'permit2')) {
          await assertPermit2NonceCurrent(slot, async (coordinate) => {
            if (coordinate.permit2 !== permit2) throw new Error('Permit2 deployment changed after review')
            const effect = current.template.effects.find(candidate => candidate.effectId === slot.insertionPoints[0]?.effectId)
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
        if (!current.template.pythRefreshSlots.length) return []
        const raw = current.plugins.rawPlan as unknown as TransactionPlan
        const sealedPreview = current.plugins.previewPlan as unknown as TransactionPlan
        const prefetch = await sdk.executionService.prefetchPluginDataForPlan(raw, current.template.wallet.account, current.template.wallet.chainId)
        const serialized = serializePluginPrefetch(prefetch)
        const refreshed = await sdk.executionService.processPlanPlugins(raw, current.template.wallet.account, current.template.wallet.chainId, prefetch)
        const evidence = collectPythPreviewEvidence(refreshed, serialized)
        return verifyRefreshedPluginPlan({
          sealedPreview,
          refreshed,
          slots: current.template.pythRefreshSlots,
          evidence,
          nowSeconds: Math.floor(Date.now() / 1000),
        })
      },
      finalize(current, signatures, pythValues) {
        return finalizeExecutionTemplate({
          ceremonyId: current.ceremonyId,
          templateDigest: current.templateDigest,
          template: current.template,
          sdk,
          signatures,
          pythValues,
        })
      },
    })
    const recovery = new CeremonyRecoveryService(journal, {
      eoa: new EoaAttemptReconciler(journal, eoa.recovery),
      safe: new SafeAttemptReconciler(journal, safe.recovery),
    })
    return { coordinator, recovery }
  }

  const accept = async (ceremonyId: Hash, consentDigest: Hash): Promise<CeremonyExecutionResult> => {
    const generation = ceremonyGenerations.get(ceremonyId)
    generation?.publisher.assertCurrent(generation.generation)
    const memoryCeremony = ceremonies.get(ceremonyId)
    const ceremony = memoryCeremony ?? await (await getJournal()).getCeremony(ceremonyId)
    if (!ceremony) throw new Error('Reviewed ceremony is unavailable')
    const { coordinator } = await executionRuntime(ceremony)
    const result = await coordinator.execute(ceremony, { ceremonyId, consentDigest })
    void invalidateSdkQueries([...INVALIDATE_AFTER_TX])
    triggerPortfolioRefresh()
    return result
  }

  const resume = async (attemptId: string) => {
    const attempt = await (await getJournal()).getAttempt(attemptId)
    if (!attempt) throw new Error('Attempt is unavailable')
    const ceremony = await (await getJournal()).getCeremony(attempt.ceremonyId)
    if (!ceremony) throw new Error('Attempt ceremony is unavailable')
    return (await executionRuntime(ceremony)).coordinator.resume(attemptId)
  }

  const reconcile = async (attemptId: string) => {
    const attempt = await (await getJournal()).getAttempt(attemptId)
    if (!attempt) throw new Error('Attempt is unavailable')
    const ceremony = await (await getJournal()).getCeremony(attempt.ceremonyId)
    if (!ceremony) throw new Error('Attempt ceremony is unavailable')
    return (await executionRuntime(ceremony)).recovery.reconcile(attemptId)
  }

  if (import.meta.client) {
    useTransactionCeremonyRecovery().registerReconciler(async (attemptId) => {
      await reconcile(attemptId)
    })
  }

  return {
    prepare,
    compileEager,
    accept,
    resume,
    reconcile,
    getCeremony,
    emergencySwitch,
  }
}
