<script setup lang="ts">
import {
  type Account,
  type IHasVaultAddress,
  isEVault,
  isSecuritizeCollateralVault,
  type AaveMigrationTargetExtraData,
  type AaveMigrationTargetRaw,
  type AavePositionRef,
  type EVault,
  type MigrationAuthorizationRequest,
  type MigrationPosition,
  type MigrationTarget,
  type MorphoMarketParams,
  type MorphoMigrationTargetRaw,
  type PluginPrefetchData,
  type PortfolioBorrowPosition,
  type SecuritizeCollateralVault,
  type SignedMigrationAuthorization,
  type TransactionPlan,
  type TransactionPlanPrepared,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { formatUnits, getAddress, type Address, type StateOverride } from 'viem'
import { OperationReviewModal } from '#components'
import { AAVE_CONNECTOR_ID, MORPHO_CONNECTOR_ID } from '~/entities/migration/constants'
import { POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS } from '~/composables/useExternalMigrationPositions'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import { formatCompactUsdValue, formatSmartAmount, trimTrailingZeros } from '~/utils/string-utils'
import { MODAL_CLOSE_REDIRECT_DELAY_MS } from '~/entities/tuning-constants'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { OP_REDEEM, OP_REPAY, OP_TRANSFER, type PlannedOp } from '~/utils/vault-hooks'
import type { DisplayStep } from '~/utils/stepDecoding'
import {
  buildMigrationAuthorizationTxSteps,
  encodeMigrationAuthorizationTxs,
  migrationAuthorizationPayloadKey,
  type MigrationAuthorizationRevoke,
} from '~/utils/migrationAuthorizationTxs'
import { logWarn } from '~/utils/errorHandling'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { BATCH_ACTIVE_REASON } from '~/utils/tx-batch-messages'
import { assertReviewedExecutionCurrent } from '~/utils/reviewedExecution'
import { assertWalletExecutionContext } from '~/utils/walletExecutionContext'
import type { TrackedExecutionScope } from '~/composables/useSafeExecutionDetachment'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'

type AaveOutgoingMigrationTarget = MigrationTarget<AaveMigrationTargetRaw, AavePositionRef, AaveMigrationTargetExtraData>

type MorphoOutgoingMigrationTarget = MigrationTarget<MorphoMigrationTargetRaw, MorphoMarketParams>

type OutgoingMigrationTarget
  = | AaveOutgoingMigrationTarget
    | MorphoOutgoingMigrationTarget

type PreparedMigrationTenderlySimulation = {
  plan: TransactionPlan
  prepared: TransactionPlanPrepared
  stateOverrides: StateOverride
}

/**
 * Everything the review modal / batch entry needs, built once per target and
 * cached. Mirrors the inbound-migration preview in
 * `pages/position/[number]/borrow/swap.vue`: the preview is warmed in the
 * background as soon as targets load, so clicking "Migrate" / "Add to batch"
 * opens the modal from cache instead of re-running the whole SDK pipeline
 * (position resolve → authorization → plan build ×2 → plugin pipeline ×2).
 */
type OutgoingMigrationInput = ReturnType<typeof buildMigrationInput>

type OutgoingMigrationPreview = {
  key: string
  useSignatures: boolean
  /**
   * The review showed the authorization riding in ONE atomic Safe proposal.
   * Latched at review time and revalidated at confirmation — execution must
   * never silently run a ceremony the user did not review.
   */
  bundledReview: boolean
  input: OutgoingMigrationInput
  account: Account<IHasVaultAddress>
  position: MigrationPosition
  authorizationRequest?: MigrationAuthorizationRequest
  tenderlySimulation: PreparedMigrationTenderlySimulation
  calldataPrepared: TransactionPlanPrepared
}

type MigrationTargetAssetLike = {
  asset: string
  symbol?: string
  decimals?: number | bigint | string
}

type TargetExternalLink = {
  href: string
  label: string
}

const route = useRoute()
const router = useRouter()
const modal = useModal()
const { error: showError } = useToast()
const { isConnected, address, chainId: walletChainId } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const { isPositionsLoading, getPositionBySubAccountIndex, refreshAllPositions } = useEulerAccount()
const { chainId } = useEulerAddresses()
const { getVault } = useVaultRegistry()
const { settings } = useUserSettings()
const { account: planAccount } = usePlanAccount()
const { buildStateOverrideOptions, primeSlotHintsFor } = useStateOverrideOptions()
const {
  listMigrationTargets,
  getMigrationPosition,
  getMigrationAuthorization,
  signMigrationAuthorization,
  executeMigrationAuthorizationGrants,
  planCrossProtocolMigration,
  planCrossProtocolMigrationSimulation,
  executePreparedPlan,
  executePreparedPlanWithPlainCalls,
  prepareTransactionPlan,
  prefetchPluginData,
} = useEulerTx()
const { signaturesEnabled } = useSignaturePreference()
const { isSafeWallet } = useSafeWallet()
const {
  restorePendingBeforeRetry,
  revokeAfterSuccess,
  revokeAfterAbort,
  toMigrationExecutionError,
} = useMigrationAuthorizationFlow()
const {
  addEntry: addBatchEntry,
  entryCount: batchEntryCount,
} = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { scheduleExternalMigrationRefreshes } = useExternalMigrationRefresh()
const { runPreparedSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()

const positionIndex = usePositionIndex()
const enableExternalMigrations = computed(() => settings.value.enableAdvancedMode)
const position = computed<PortfolioBorrowPosition<VaultEntity> | undefined>(() =>
  getPositionBySubAccountIndex(Number(positionIndex)),
)
const sourceDebtVault = computed<EVault | undefined>(() =>
  position.value?.borrowVault as EVault | undefined,
)
const selectedCollateralAddress = computed(() =>
  typeof route.query.collateral === 'string' ? normalizeAddressKey(route.query.collateral) : '',
)
const sourceCollateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() => {
  const currentPosition = position.value
  if (!currentPosition) return undefined

  if (selectedCollateralAddress.value) {
    const selectedCollateral = currentPosition.collaterals.find(collateral =>
      normalizeAddressKey(collateral.vaultAddress) === selectedCollateralAddress.value
      || normalizeAddressKey(collateral.vault?.address) === selectedCollateralAddress.value,
    )
    if (selectedCollateral) {
      const selectedVault = selectedCollateral.vault ?? getVault(selectedCollateralAddress.value)
      if (selectedVault) return selectedVault as EVault | SecuritizeCollateralVault
    }
  }

  return currentPosition.collateralVault as EVault | SecuritizeCollateralVault | undefined
})
const sourceCollateralEVault = computed<EVault | undefined>(() => {
  const vault = sourceCollateralVault.value
  if (!vault || isSecuritizeCollateralVault(vault)) return undefined
  return vault as EVault
})
const sourceCollateralPosition = computed(() => {
  const sourceAddress = normalizeAddressKey(sourceCollateralVault.value?.address)
  if (!sourceAddress) return null
  const matchedCollateral = position.value?.collaterals.find(collateral =>
    normalizeAddressKey(collateral.vaultAddress) === sourceAddress
    || normalizeAddressKey(collateral.vault?.address) === sourceAddress,
  )
  if (matchedCollateral) return matchedCollateral
  const primaryCollateral = position.value?.collateral
  return primaryCollateral && normalizeAddressKey(primaryCollateral.vaultAddress) === sourceAddress
    ? primaryCollateral
    : null
})
const currentDebt = computed(() => position.value?.borrowed ?? 0n)
const currentCollateralAssets = computed(() =>
  sourceCollateralPosition.value?.assets ?? position.value?.supplied ?? 0n,
)
const sourcePairLabel = computed(() => {
  const collateral = sourceCollateralVault.value?.asset.symbol ?? ''
  const debt = sourceDebtVault.value?.asset.symbol ?? ''
  return collateral && debt ? `${collateral}/${debt}` : 'Position'
})
const sourcePositionAriaLabel = computed(() =>
  `Source position ${positionIndex}: ${sourcePairLabel.value}`,
)
const positionDetailsFallback = computed(() => {
  const query = new URLSearchParams()
  const network = route.query.network
  if (typeof network === 'string') query.set('network', network)
  else if (Array.isArray(network) && network[0]) query.set('network', network[0])
  const search = query.toString()
  return `/position/${positionIndex}${search ? `?${search}` : ''}`
})
// Migration authorization must be signed by a real connected wallet. Spy mode
// stays read-only (discovery/preview) and cannot sign, so it must not satisfy
// the review/execute gate — otherwise a spy-only user passes "Connect wallet to
// migrate" and fails later at signing.
const hasConnectedWallet = computed(() => isConnected.value)
const migrationOwner = computed<Address | undefined>(() => {
  const raw = isSpyMode.value ? spyAddress.value : address.value
  if (!raw) return undefined
  try {
    return getAddress(raw)
  }
  catch {
    return undefined
  }
})
const migrationAccount = computed<Address | undefined>(() => {
  if (!position.value) return undefined
  try {
    return getAddress(position.value.subAccount)
  }
  catch {
    return undefined
  }
})

const outgoingMigrationInterestBufferBps = 1n
const outgoingMigrationBorrowAmountWithBuffer = computed(() =>
  currentDebt.value > 0n
    ? (currentDebt.value * (10_000n + outgoingMigrationInterestBufferBps) + 9_999n) / 10_000n
    : 0n,
)
const targets = shallowRef<OutgoingMigrationTarget[]>([])
const isTargetsLoading = ref(false)
const hasLoadedTargets = ref(false)
const targetsError = ref('')
const reviewingTargetId = ref('')
const batchingTargetId = ref('')
const submittingTargetId = ref('')
const targetLiquidityUsdById = shallowRef<Record<string, number | null>>({})
let targetsRequestId = 0
let targetLiquidityUsdRequestId = 0

const MORPHO_APP_CHAIN_SLUGS: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
}
const AAVE_APP_MARKET_SLUGS: Record<string, string> = {
  AaveV3Ethereum: 'proto_mainnet_v3',
  AaveV3EthereumLido: 'proto_lido_v3',
  AaveV3EthereumEtherFi: 'proto_etherfi_v3',
  AaveV3Base: 'proto_base_v3',
  AaveV3Arbitrum: 'proto_arbitrum_v3',
  AaveV3Optimism: 'proto_optimism_v3',
  AaveV3Polygon: 'proto_polygon_v3',
  AaveV3Avalanche: 'proto_avalanche_v3',
  AaveV3BNB: 'proto_bnb_v3',
  AaveV3Gnosis: 'proto_gnosis_v3',
  AaveV3Scroll: 'proto_scroll_v3',
  AaveV3Linea: 'proto_linea_v3',
  AaveV3ZkSync: 'proto_zksync_v3',
  AaveV3Sonic: 'proto_sonic_v3',
  AaveV3Celo: 'proto_celo_v3',
  AaveV3Soneium: 'proto_soneium_v3',
  AaveV3Metis: 'proto_metis_v3',
}
const AAVE_DEFAULT_MARKET_SLUGS_BY_CHAIN: Record<number, string> = {
  1: 'proto_mainnet_v3',
  8453: 'proto_base_v3',
  42161: 'proto_arbitrum_v3',
  10: 'proto_optimism_v3',
  137: 'proto_polygon_v3',
  43114: 'proto_avalanche_v3',
  56: 'proto_bnb_v3',
  100: 'proto_gnosis_v3',
  534352: 'proto_scroll_v3',
  59144: 'proto_linea_v3',
  324: 'proto_zksync_v3',
  146: 'proto_sonic_v3',
  42220: 'proto_celo_v3',
  1868: 'proto_soneium_v3',
  1088: 'proto_metis_v3',
}

const isMorphoTarget = (
  target: OutgoingMigrationTarget | undefined,
): target is MorphoOutgoingMigrationTarget =>
  target?.connectorId === MORPHO_CONNECTOR_ID
const isAaveTarget = (
  target: OutgoingMigrationTarget | undefined,
): target is AaveOutgoingMigrationTarget =>
  target?.connectorId === AAVE_CONNECTOR_ID
const targetAssetSymbol = (target: OutgoingMigrationTarget, leg: 'debt' | 'collateral') => {
  const asset = leg === 'debt' ? target.debt : target.collateral
  const fallback = leg === 'debt'
    ? sourceDebtVault.value?.asset.symbol
    : sourceCollateralEVault.value?.asset.symbol
  return asset.symbol || fallback || ''
}
const targetPairLabel = (target: OutgoingMigrationTarget) => {
  const collateral = targetAssetSymbol(target, 'collateral')
  const debt = targetAssetSymbol(target, 'debt')
  return collateral && debt ? `${collateral}/${debt}` : sourcePairLabel.value
}
const targetAvatarAssets = (target: OutgoingMigrationTarget) => [
  { address: target.collateral.asset, symbol: targetAssetSymbol(target, 'collateral') },
  { address: target.debt.asset, symbol: targetAssetSymbol(target, 'debt') },
]
const formatAaveDeploymentLabel = (marketName: string) =>
  marketName
    .replace(/^AaveV3/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^Ethereum$/, 'Ethereum Core')
    .trim()
const targetMarketName = (target: OutgoingMigrationTarget) =>
  isAaveTarget(target) ? target.extraData?.marketName ?? target.raw?.marketName ?? '' : ''
const targetMarketLabel = (target: OutgoingMigrationTarget) => {
  const marketName = targetMarketName(target)
  return marketName ? formatAaveDeploymentLabel(marketName) : ''
}
const targetProtocolDisplay = (target: OutgoingMigrationTarget) => {
  const market = targetMarketLabel(target)
  return market ? `${target.protocol} ${market}` : target.protocol
}
const targetLltv = (target: OutgoingMigrationTarget | undefined): number | null =>
  isMorphoTarget(target) ? target.raw?.lltv ?? null : null

// Only called from the non-Aave (`v-else`) template branch; Aave targets render
// their per-asset links via `aaveAssetExternalLink` instead. Handles Morpho only.
const targetExternalLinks = (target: OutgoingMigrationTarget): TargetExternalLink[] => {
  if (isMorphoTarget(target)) {
    const chainSlug = MORPHO_APP_CHAIN_SLUGS[target.chainId]
    if (!chainSlug || !target.raw?.marketId) return []
    return [{
      href: `https://app.morpho.org/${chainSlug}/market/${target.raw.marketId}`,
      label: `Open Morpho ${targetPairLabel(target)} market`,
    }]
  }

  return []
}

const aaveAssetExternalLink = (
  target: OutgoingMigrationTarget,
  leg: 'collateral' | 'debt',
): TargetExternalLink | null => {
  if (!isAaveTarget(target)) return null
  const marketName = targetMarketName(target)
  const marketSlug = marketName
    ? AAVE_APP_MARKET_SLUGS[marketName]
    : AAVE_DEFAULT_MARKET_SLUGS_BY_CHAIN[target.chainId]
  if (!marketSlug) return null

  const asset = leg === 'collateral' ? target.collateral.asset : target.debt.asset
  const symbol = targetAssetSymbol(target, leg)
  return {
    href: `https://app.aave.com/reserve-overview/?underlyingAsset=${getAddress(asset).toLowerCase()}&marketName=${marketSlug}`,
    label: `Open Aave ${targetMarketLabel(target) || 'market'} ${symbol || 'asset'} pool`,
  }
}

const collateralValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!sourceCollateralEVault.value) {
    collateralValueUsd.value = null
    return
  }
  collateralValueUsd.value = (await getAssetUsdValue(currentCollateralAssets.value, sourceCollateralEVault.value, 'off-chain')) ?? null
})
const debtValueUsd = ref<number | null>(null)
watchEffect(async () => {
  if (!sourceDebtVault.value) {
    debtValueUsd.value = null
    return
  }
  debtValueUsd.value = (await getAssetUsdValue(outgoingMigrationBorrowAmountWithBuffer.value, sourceDebtVault.value, 'off-chain')) ?? null
})
const targetLtv = (_target: OutgoingMigrationTarget) => {
  if (!collateralValueUsd.value || collateralValueUsd.value <= 0 || debtValueUsd.value === null) return null
  return (debtValueUsd.value / collateralValueUsd.value) * 100
}
const targetHealth = (target: OutgoingMigrationTarget) => {
  const lltv = targetLltv(target)
  const ltv = targetLtv(target)
  if (!lltv || !ltv || ltv <= 0) return null
  return lltv / ltv
}
const plannedOps = computed<PlannedOp[]>(() => {
  if (!sourceDebtVault.value || !sourceCollateralEVault.value) return []
  const steps: PlannedOp[] = [
    { vault: sourceCollateralEVault.value, op: OP_REDEEM },
    { vault: sourceDebtVault.value, op: OP_REPAY },
  ]
  // The outgoing plan always runs the Euler cleanup pass: when the position
  // lives on a sub-account, every other enabled collateral with residual
  // shares is swept back to the owner via transferFromMax, so a vault with
  // hooked share transfers blocks the whole migration.
  const subAccountAddress = migrationAccount.value
  const owner = migrationOwner.value
  const account = planAccount.value
  if (!subAccountAddress || !owner || !account || sameAssetAddress(subAccountAddress, owner)) return steps
  const subAccount = account.getSubAccount(subAccountAddress)
  for (const collateral of subAccount?.enabledCollaterals ?? []) {
    if (sameAssetAddress(collateral, sourceCollateralEVault.value.address)) continue
    const collateralPosition = subAccount?.positions.find(entry => sameAssetAddress(entry.vaultAddress, collateral))
    if (collateralPosition && collateralPosition.shares > 0n && isEVault(collateralPosition.vault)) {
      steps.push({ vault: collateralPosition.vault, op: OP_TRANSFER })
    }
  }
  return steps
})
const hookWarning = computed(() => getPlanHookDisabledWarning(plannedOps.value))
const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(
  ...[
    sourceDebtVault.value?.address,
    sourceCollateralVault.value?.address,
  ].filter((value): value is Address => !!value),
))
const canLoadTargets = computed(() =>
  enableExternalMigrations.value
  && !!chainId.value
  && !!sourceDebtVault.value
  && !!sourceCollateralEVault.value
  && currentDebt.value > 0n,
)
const pageDisabledReason = computed(() => {
  if (!enableExternalMigrations.value) return 'Enable advanced mode in settings'
  if (isGeoBlocked.value) return 'This operation is not available in your region'
  if (!sourceDebtVault.value || !sourceCollateralEVault.value || !migrationAccount.value) return 'Migration requires standard Euler collateral and debt vaults'
  if (!planAccount.value) return 'Account data is loading'
  if (currentDebt.value <= 0n) return 'This position has no debt to migrate out'
  if (hookWarning.value) return hookWarning.value.message
  return ''
})
const noTargetsFound = computed(() =>
  canLoadTargets.value
  && hasLoadedTargets.value
  && !isTargetsLoading.value
  && !targetsError.value
  && targets.value.length === 0,
)

useOperationGuard(computed(() => [
  sourceDebtVault.value?.address,
  sourceCollateralVault.value?.address,
].filter(Boolean)))

watch(
  [
    enableExternalMigrations,
    chainId,
    computed(() => sourceDebtVault.value?.asset.address),
    computed(() => sourceCollateralEVault.value?.asset.address),
    outgoingMigrationBorrowAmountWithBuffer,
  ],
  () => {
    void loadTargets()
  },
  { immediate: true },
)
watch([targets, sourceDebtVault, sourceCollateralEVault], () => {
  clearSimulationError()
})
watch([targets, sourceDebtVault], () => {
  void loadTargetLiquidityUsd()
}, { immediate: true })
watch([sourceDebtVault, sourceCollateralEVault], ([sourceDebt, sourceCollateral]) => {
  const tokens = [sourceDebt?.asset.address, sourceCollateral?.asset.address].filter((value): value is Address => !!value)
  if (tokens.length) void primeSlotHintsFor(tokens)
}, { immediate: true })

async function loadTargets() {
  const requestId = ++targetsRequestId
  if (!canLoadTargets.value) {
    targets.value = []
    hasLoadedTargets.value = false
    targetsError.value = ''
    isTargetsLoading.value = false
    return
  }

  const targetChainId = chainId.value
  const debtAsset = sourceDebtVault.value.asset.address as Address
  const collateralAsset = sourceCollateralEVault.value.asset.address as Address
  isTargetsLoading.value = true
  targetsError.value = ''
  try {
    const result = await listMigrationTargets({
      direction: 'euler-to-external',
      chainId: targetChainId,
      debtAsset,
      collateralAsset,
      minLiquidity: outgoingMigrationBorrowAmountWithBuffer.value,
    })
    const compatibleTargets = result
      .filter((target): target is OutgoingMigrationTarget =>
        target.chainId === targetChainId
        && sameAssetAddress(target.debt.asset, debtAsset)
        && sameAssetAddress(target.collateral.asset, collateralAsset),
      )
    if (requestId !== targetsRequestId) return
    targets.value = compatibleTargets
    hasLoadedTargets.value = true
  }
  catch (err) {
    if (requestId !== targetsRequestId) return
    hasLoadedTargets.value = true
    targetsError.value = err instanceof Error ? err.message : 'Failed to load migration targets'
    logWarn('positionMigration/targets', err)
  }
  finally {
    if (requestId === targetsRequestId) {
      isTargetsLoading.value = false
    }
  }
}

async function loadTargetLiquidityUsd() {
  const requestId = ++targetLiquidityUsdRequestId
  const currentTargets = targets.value
  if (!currentTargets.length) {
    targetLiquidityUsdById.value = {}
    return
  }

  const debtVault = sourceDebtVault.value
  const entries = await Promise.all(currentTargets.map(async (target) => {
    if (isMorphoTarget(target) && typeof target.raw?.liquidityAssetsUsd === 'number') {
      return [target.id, target.raw.liquidityAssetsUsd] as const
    }
    if (!target.liquidity || !debtVault) return [target.id, null] as const
    const usd = await getAssetUsdValue(target.liquidity.amount, debtVault, 'off-chain')
    return [target.id, usd ?? null] as const
  }))
  if (requestId !== targetLiquidityUsdRequestId) return
  targetLiquidityUsdById.value = Object.fromEntries(entries)
}

function getTargetDisabledReason(target: OutgoingMigrationTarget | undefined) {
  if (pageDisabledReason.value) return pageDisabledReason.value
  if (!hasConnectedWallet.value) return 'Connect wallet to migrate'
  if (isTargetsLoading.value) return 'Loading migration targets'
  if (targetsError.value && !target) return targetsError.value
  if (hasLoadedTargets.value && !target) return 'No compatible migration target'
  if (!target) return 'No compatible migration target'
  const health = targetHealth(target)
  if (health !== null && health <= 1) return `${targetProtocolDisplay(target)} target would be unhealthy`
  if (simulationError.value) return simulationError.value
  return null
}

const isBatchActive = computed(() => batchEntryCount.value > 0)
const directMigrationDisabledReason = computed(() => isBatchActive.value ? BATCH_ACTIVE_REASON : null)

function getTargetMigrateDisabledReason(target: OutgoingMigrationTarget | undefined) {
  return directMigrationDisabledReason.value || getTargetDisabledReason(target)
}

function canUseTarget(target: OutgoingMigrationTarget) {
  return !!migrationOwner.value
    && !getTargetDisabledReason(target)
    && !isTargetsLoading.value
}

function canReviewTarget(target: OutgoingMigrationTarget) {
  return canUseTarget(target) && !directMigrationDisabledReason.value
}

function canAddToBatchTarget(target: OutgoingMigrationTarget) {
  return canUseTarget(target)
}

function buildMigrationInput(
  target: OutgoingMigrationTarget,
  useSignatures = signaturesEnabled.value,
  owner = migrationOwner.value,
) {
  if (!chainId.value || !owner || !migrationAccount.value || !sourceDebtVault.value || !sourceCollateralEVault.value) {
    throw new Error('Migration inputs are incomplete')
  }

  const source = {
    eulerAccount: migrationAccount.value,
    borrowVault: sourceDebtVault.value.address as Address,
    collateralVault: sourceCollateralEVault.value.address as Address,
    debtAmount: currentDebt.value,
  }
  const externalTarget = {
    interestBufferBps: outgoingMigrationInterestBufferBps,
  }
  // The SDK's post-migration disable is a second signed authorization appended
  // to the batch. Without signatures the revoke is a plain tx sent afterwards.
  const removeAuthorizationAfterMigration = target.connectorId === MORPHO_CONNECTOR_ID && useSignatures
  const cleanupEulerPosition = true
  return {
    owner,
    target,
    source,
    externalTarget,
    removeAuthorizationAfterMigration,
    cleanupEulerPosition,
  }
}

async function getAuthorizationRequest(
  input: OutgoingMigrationInput,
  migrationPosition?: MigrationPosition,
  account?: Account<IHasVaultAddress>,
  useSignatures = signaturesEnabled.value,
): Promise<MigrationAuthorizationRequest | undefined> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
  return getMigrationAuthorization({
    direction: 'euler-to-external',
    connectorId: input.target.connectorId,
    chainId: input.target.chainId,
    owner: input.owner,
    position: migrationPosition,
    positionRef: input.target.ref,
    source: input.source,
    externalTarget: input.externalTarget,
    account,
    removeAuthorizationAfterMigration: input.removeAuthorizationAfterMigration,
    // Without signatures the connectors return msg.sender grants to send as
    // their own transactions instead of an EIP-712 message to sign.
    authorizationKind: useSignatures ? 'typedData' : 'transaction',
    deadline,
  })
}

async function buildMigrationPlan(
  input: OutgoingMigrationInput,
  authorization?: SignedMigrationAuthorization,
  migrationPosition?: MigrationPosition,
  account: Account<IHasVaultAddress> | undefined = planAccount.value,
): Promise<TransactionPlan> {
  return planCrossProtocolMigration({
    direction: 'euler-to-external',
    connectorId: input.target.connectorId,
    chainId: input.target.chainId,
    owner: input.owner,
    position: migrationPosition,
    positionRef: input.target.ref,
    source: input.source,
    externalTarget: input.externalTarget,
    authorization,
    removeAuthorizationAfterMigration: input.removeAuthorizationAfterMigration,
    account,
    cleanupEulerPosition: input.cleanupEulerPosition,
    operationName: `${input.target.connectorId}OutgoingMigration`,
  })
}

async function buildMigrationSimulation(
  input: OutgoingMigrationInput,
  migrationPosition: MigrationPosition,
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  account?: Account<IHasVaultAddress>,
) {
  return planCrossProtocolMigrationSimulation({
    direction: 'euler-to-external',
    connectorId: input.target.connectorId,
    chainId: input.target.chainId,
    owner: input.owner,
    position: migrationPosition,
    positionRef: input.target.ref,
    source: input.source,
    externalTarget: input.externalTarget,
    authorizationRequest,
    removeAuthorizationAfterMigration: input.removeAuthorizationAfterMigration,
    account,
    cleanupEulerPosition: input.cleanupEulerPosition,
    operationName: `${input.target.connectorId}OutgoingMigration`,
  })
}

// --- Per-target preview cache -------------------------------------------
// Key spans every input that changes the built plan; any change invalidates
// the whole cache (epoch bump) so stale previews can never be shown.
const outgoingPreviewBaseKey = computed(() => {
  if (
    !canLoadTargets.value
    || !migrationOwner.value
    || !migrationAccount.value
    || !sourceDebtVault.value
    || !sourceCollateralEVault.value
    || !planAccount.value
  ) return ''
  return [
    chainId.value,
    migrationOwner.value,
    migrationAccount.value,
    sourceDebtVault.value.address,
    sourceCollateralEVault.value.address,
    currentDebt.value.toString(),
    outgoingMigrationBorrowAmountWithBuffer.value.toString(),
    // Signature mode changes the built plan and the displayed steps.
    signaturesEnabled.value ? 'sig' : 'nosig',
  ].join('|')
})
const outgoingPreviews = shallowRef<Record<string, OutgoingMigrationPreview>>({})
const outgoingPreviewPromises = new Map<string, Promise<OutgoingMigrationPreview>>()
let outgoingPreviewEpoch = 0
const STALE_OUTGOING_MIGRATION_PREVIEW_ERROR = 'Migration inputs changed while preparing preview'

const outgoingPreviewKeyFor = (target: OutgoingMigrationTarget) => {
  const base = outgoingPreviewBaseKey.value
  return base ? `${base}|${target.id}` : ''
}

/**
 * Evict one cached preview so the next review rebuilds it. Used when the
 * confirmation gate detects that authorization state drifted since review —
 * returning the stale cache would re-present the very ceremony that was
 * rejected.
 */
function invalidateOutgoingMigrationPreview(key: string) {
  if (!(key in outgoingPreviews.value)) return
  outgoingPreviews.value = Object.fromEntries(
    Object.entries(outgoingPreviews.value).filter(([cachedKey]) => cachedKey !== key),
  )
}

async function prepareOutgoingMigrationPreview(
  target: OutgoingMigrationTarget,
): Promise<OutgoingMigrationPreview> {
  const key = outgoingPreviewKeyFor(target)
  if (!key) throw new Error('Migration inputs are incomplete')

  const cached = outgoingPreviews.value[key]
  if (cached) return cached
  const pending = outgoingPreviewPromises.get(key)
  if (pending) return pending

  const epoch = outgoingPreviewEpoch
  const promise = (async () => {
    const useSignatures = signaturesEnabled.value
    const input = buildMigrationInput(target, useSignatures)
    const account = planAccount.value
    if (!account) throw new Error('Migration inputs are incomplete')

    // Resolve the external position once and thread it through every SDK
    // call below — without it each plan/authorization call re-resolves the
    // position on-chain (market lookup + balance multicalls).
    const migrationPosition = await getMigrationPosition({
      connectorId: input.target.connectorId,
      chainId: input.target.chainId,
      owner: input.owner,
      positionRef: input.target.ref,
    })

    // Match the inbound migration flow: resolve the exact authorization form
    // first, then pass it into simulation. In no-signature mode this must be a
    // standalone transaction request so the review can list its grant/revoke
    // rows instead of receiving the SDK's default typed-data request.
    const authorizationRequest = await getAuthorizationRequest(
      input,
      migrationPosition,
      account,
      useSignatures,
    )
    // One batch build returns both plans: the simulation plan (auth item
    // stripped, replaced by state overrides) and the stub-signed preview
    // plan for calldata display.
    const simulationResult = await buildMigrationSimulation(
      input,
      migrationPosition,
      authorizationRequest,
      account,
    )

    // Resolve plugin payloads (Pyth Hermes pull, Keyring reads, TOS) once,
    // then run both prepares in parallel against the shared prefetch.
    let prefetch: PluginPrefetchData | undefined
    try {
      prefetch = await prefetchPluginData(simulationResult.plan, { account })
    }
    catch (err) {
      logWarn('positionMigration/prefetchPluginData', err)
    }
    const prepareOptions = {
      account,
      chainId: input.target.chainId,
      prefetch,
      usePermit2: useSignatures,
    }
    // Without signatures the authorization is granted by a standalone tx, so the
    // simulation plan (authorization item filtered out) is already the exact
    // calldata that executes — no stub-signed preview plan needed.
    const [tenderlyPrepared, previewPrepared] = await Promise.all([
      prepareTransactionPlan(simulationResult.plan, prepareOptions),
      useSignatures
        ? prepareTransactionPlan(simulationResult.previewPlan, prepareOptions)
        : Promise.resolve(undefined),
    ])
    const calldataPrepared = previewPrepared ?? tenderlyPrepared

    if (epoch !== outgoingPreviewEpoch || key !== outgoingPreviewKeyFor(target)) {
      throw new Error(STALE_OUTGOING_MIGRATION_PREVIEW_ERROR)
    }

    const preview: OutgoingMigrationPreview = {
      key,
      useSignatures,
      bundledReview: !useSignatures && isSafeWallet.value && !!authorizationRequest,
      input,
      account,
      position: migrationPosition,
      tenderlySimulation: {
        plan: simulationResult.plan,
        prepared: tenderlyPrepared,
        stateOverrides: simulationResult.stateOverrides,
      },
      calldataPrepared,
      ...(authorizationRequest
        ? { authorizationRequest }
        : {}),
    }
    outgoingPreviews.value = { ...outgoingPreviews.value, [key]: preview }
    return preview
  })()

  outgoingPreviewPromises.set(key, promise)
  const release = () => {
    if (outgoingPreviewPromises.get(key) === promise) outgoingPreviewPromises.delete(key)
  }
  promise.then(release, release)

  return promise
}

// Warm previews sequentially (bounded RPC burst) as soon as targets settle,
// so the review modal opens from cache on click.
const warmOutgoingMigrationPreviews = useDebounceFn(async () => {
  const epoch = outgoingPreviewEpoch
  for (const target of targets.value) {
    if (epoch !== outgoingPreviewEpoch) return
    if (!canUseTarget(target)) continue
    try {
      await prepareOutgoingMigrationPreview(target)
    }
    catch (err) {
      if (err instanceof Error && err.message === STALE_OUTGOING_MIGRATION_PREVIEW_ERROR) return
      logWarn('positionMigration/warmPreview', err)
    }
  }
}, 250)

watch([targets, outgoingPreviewBaseKey], ([targetList, baseKey]) => {
  outgoingPreviewEpoch++
  outgoingPreviews.value = {}
  outgoingPreviewPromises.clear()
  if (baseKey && targetList.length) void warmOutgoingMigrationPreviews()
}, { immediate: true })

async function reviewMigration(target: OutgoingMigrationTarget) {
  if (reviewingTargetId.value || submittingTargetId.value || isOperationBlocked.value || !canReviewTarget(target) || !sourceDebtVault.value) return
  reviewingTargetId.value = target.id
  clearSimulationError()
  try {
    const preview = await prepareOutgoingMigrationPreview(target)

    modal.open(OperationReviewModal, {
      props: {
        type: 'migration',
        asset: sourceDebtVault.value.asset,
        amount: formatVaultAmount(currentDebt.value, sourceDebtVault.value),
        signatureSteps: buildSignatureSteps(preview.input.target, preview.authorizationRequest, preview.useSignatures, preview.bundledReview),
        postSteps: buildRevokeSteps(preview.authorizationRequest, preview.useSignatures, preview.bundledReview),
        calldataPrepared: preview.calldataPrepared,
        calldataUsesPlaceholderSignatures: preview.useSignatures && !!preview.authorizationRequest,
        calldataWrapCalls: buildCalldataWrapCalls(preview.authorizationRequest, preview.bundledReview),
        tenderlyPrepared: preview.tenderlySimulation.prepared,
        tenderlyStateOverrides: preview.tenderlySimulation.stateOverrides,
        allowConfirmWithoutPlan: true,
        onConfirm: async (execution) => {
          await sendMigration(execution, preview)
        },
        submittingLabel: 'Migrating...',
      },
    })
  }
  catch (err) {
    logWarn('positionMigration/review', err)
    showError(err instanceof Error ? err.message : 'Failed to build migration')
  }
  finally {
    reviewingTargetId.value = ''
  }
}

async function sendMigration(execution: TrackedExecutionScope, preview: OutgoingMigrationPreview) {
  const { input: reviewedInput, account: reviewedAccount, position: migrationPosition, useSignatures } = preview
  const { target } = reviewedInput
  submittingTargetId.value = target.id
  clearSimulationError()
  try {
    assertReviewedExecutionCurrent({
      reviewedKey: preview.key,
      currentKey: outgoingPreviewKeyFor(target),
    })
    assertWalletExecutionContext({
      expectedAccount: reviewedInput.owner,
      expectedChainId: target.chainId,
      currentAccount: address.value as Address | undefined,
      currentChainId: walletChainId.value,
    })
    if (!await restorePendingBeforeRetry()) return
    const input = reviewedInput
    const authorizationRequest = await getAuthorizationRequest(input, migrationPosition, reviewedAccount, useSignatures)

    // The reviewed ceremony is defined by the authorization payload the modal
    // displayed and copied. Authorization state can drift between review and
    // confirmation (an allowance granted or revoked elsewhere, a restore
    // value that moved) — executing the fresh payload would add or remove
    // grant/revoke calls the user never reviewed. Evict the cached preview so
    // the re-review builds against the current state.
    if (migrationAuthorizationPayloadKey(authorizationRequest) !== migrationAuthorizationPayloadKey(preview.authorizationRequest)) {
      invalidateOutgoingMigrationPreview(preview.key)
      throw new Error('Authorization requirements changed since review — please review the migration again.')
    }

    // An undefined request means the grant is already live on-chain: nothing to
    // sign, nothing to grant, and nothing of ours to revoke afterwards.
    let authorization: SignedMigrationAuthorization | undefined
    const revokeTxs: MigrationAuthorizationRevoke[] = []
    try {
      if (preview.bundledReview) {
        // The review promised ONE atomic Safe proposal. Revalidate that mode
        // at confirmation: a wallet that no longer classifies as a Safe must
        // re-review, never silently receive the sequential multi-proposal
        // ceremony; a degraded Safe (provider unavailable) throws inside the
        // bundle helper.
        if (!isSafeWallet.value) {
          throw new Error('Wallet changed since review — please review the migration again.')
        }
        // bundledReview implies the review carried a request, and payload
        // equality above pins the fresh one to it — reaching here without
        // one is drift the gate somehow missed, so fail closed.
        if (!authorizationRequest) {
          invalidateOutgoingMigrationPreview(preview.key)
          throw new Error('Authorization requirements changed since review — please review the migration again.')
        }
        const outcome = await sendMigrationAsSafeBundle(input, migrationPosition, authorizationRequest, reviewedAccount)
        if (outcome === 'aborted') return
        finishMigrationSuccess(execution)
        return
      }

      if (authorizationRequest) {
        if (useSignatures) {
          authorization = await signMigrationAuthorization(authorizationRequest)
        }
        else {
          // Record each revoke as soon as its grant is broadcast so partial or
          // receipt-ambiguous failures can still unwind what may have landed.
          await executeMigrationAuthorizationGrants(authorizationRequest, revokeTxs)
        }
      }
      const plan = await buildMigrationPlan(input, authorization, migrationPosition, reviewedAccount)
      const prepared = await prepareTransactionPlan(plan, {
        account: reviewedAccount,
        chainId: input.target.chainId,
        usePermit2: useSignatures,
      })
      const ok = await runPreparedSimulation(prepared, buildStateOverrideOptions({ noBalanceOverride: true }))
      if (!ok) {
        await revokeAfterAbort(revokeTxs)
        return
      }
      await executePreparedPlan(prepared)
    }
    catch (err) {
      // Covers a rejected batch, a failed prepare, and a stale grant.
      await revokeAfterAbort(revokeTxs)
      throw toMigrationExecutionError(err)
    }

    await revokeAfterSuccess(revokeTxs)
    finishMigrationSuccess(execution)
  }
  catch (err) {
    showError(err instanceof Error ? err.message : 'Migration failed')
    logWarn('positionMigration/send', err)
  }
  finally {
    submittingTargetId.value = ''
  }
}

/**
 * The grant/revocation calls the Safe bundle wraps around the migration plan
 * — surfaced so Copy calldata matches the actual proposal. Empty for
 * signature-mode migrations and non-Safe wallets (which broadcast them as
 * standalone transactions instead).
 */
function buildCalldataWrapCalls(
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  bundledReview: boolean,
) {
  // Driven by the latched review mode, not live detection — displayed and
  // copied calldata must match the ceremony the confirmation will run.
  if (!authorizationRequest || !bundledReview) return undefined
  const { grants, revokes } = encodeMigrationAuthorizationTxs(authorizationRequest)
  return { before: grants, after: revokes }
}

function finishMigrationSuccess(execution: TrackedExecutionScope) {
  // Success signal for a detached Safe completion toast; a proposal that
  // confirmed after its modal was closed must not yank the user mid-flow.
  // Bound to THIS execution's record.
  execution.markSucceeded()
  schedulePostMigrationRefreshes()
  if (execution.suppressPostTxUi()) return
  modal.close()
  setTimeout(() => {
    void router.replace({ path: '/portfolio', query: { network: route.query.network } })
  }, MODAL_CLOSE_REDIRECT_DELAY_MS)
}

/**
 * Execute the migration as one atomic Safe proposal: authorization grants,
 * the migration batch, and the revocations in a single wallet_sendCalls
 * bundle. The plan comes from the simulation variant, which is byte-identical
 * to the execution plan for transaction-kind authorizations but validates the
 * grant instead of reading the live allowance — so nothing needs to be mined
 * before the bundle is built. The pre-bundle simulation runs with the SDK's
 * authorization state overrides for the same reason.
 *
 * Returns 'executed' when the bundle confirmed, 'aborted' when the simulation
 * rejected (nothing on-chain, nothing to unwind), or 'unavailable' when there
 * is no Safe bundle context — the caller falls back to sequential grants.
 */
async function sendMigrationAsSafeBundle(
  input: OutgoingMigrationInput,
  migrationPosition: MigrationPosition,
  authorizationRequest: MigrationAuthorizationRequest,
  account?: Account<IHasVaultAddress>,
): Promise<'executed' | 'aborted'> {
  const { grants, revokes } = encodeMigrationAuthorizationTxs(authorizationRequest)
  const simulation = await buildMigrationSimulation(input, migrationPosition, authorizationRequest, account)
  const prepared = await prepareTransactionPlan(simulation.plan, {
    account,
    chainId: input.target.chainId,
    usePermit2: false,
  })
  const ok = await runPreparedSimulation(
    prepared,
    buildStateOverrideOptions({ noBalanceOverride: true }),
    simulation.stateOverrides,
  )
  if (!ok) return 'aborted'

  const result = await executePreparedPlanWithPlainCalls(prepared, { before: grants, after: revokes }, { allowSingleCall: true })
  if (!result) {
    throw new Error('Safe connection unavailable — the reviewed single-proposal submission cannot run. Reconnect your Safe and retry.')
  }
  return 'executed'
}

async function addMigrationToBatch(target: OutgoingMigrationTarget) {
  if (batchingTargetId.value || !canAddToBatchTarget(target) || !sourceDebtVault.value || !sourceCollateralEVault.value || !migrationAccount.value) return
  batchingTargetId.value = target.id
  clearSimulationError()
  try {
    const preview = await prepareOutgoingMigrationPreview(target)
    await addPreparedMigrationToBatch(preview)
  }
  catch (err) {
    logWarn('positionMigration/batchReview', err)
    showError(err instanceof Error ? err.message : 'Failed to add migration to batch')
  }
  finally {
    batchingTargetId.value = ''
  }
}

async function addPreparedMigrationToBatch(preview: OutgoingMigrationPreview) {
  if (!sourceDebtVault.value || !sourceCollateralEVault.value || !migrationAccount.value) {
    throw new Error('Migration inputs are incomplete')
  }

  const { input, position: migrationPosition, authorizationRequest, useSignatures } = preview
  const sourceDebtAsset = sourceDebtVault.value.asset
  const sourceDebtSymbol = sourceDebtAsset.symbol
  const sourceCollateralSymbol = sourceCollateralEVault.value.asset.symbol
  const debtAmount = formatVaultAmount(currentDebt.value, sourceDebtVault.value)
  const batchEntry = {
    label: `Migrate ${sourceCollateralSymbol}/${sourceDebtSymbol} to ${targetProtocolDisplay(input.target)}`,
    nameOverride: `Migrate ${sourceCollateralSymbol}/${sourceDebtSymbol}`,
    buildExecutionPlan: async (account: Account<IHasVaultAddress>) => {
      const executionAuthorizationRequest = useSignatures
        ? await getAuthorizationRequest(input, migrationPosition, account, useSignatures)
        : undefined
      const authorization = executionAuthorizationRequest
        ? await signMigrationAuthorization(executionAuthorizationRequest)
        : undefined
      // Without signatures the grant was already mined by the batch's pre-phase,
      // so the connector omits the authorization item from the plan.
      return buildMigrationPlan(input, authorization, migrationPosition, account)
    },
    ...(useSignatures
      ? {}
      : {
          buildExecutionPrerequisites: async (account: Account<IHasVaultAddress>) => {
            const request = await getAuthorizationRequest(input, migrationPosition, account, useSignatures)
            if (!request) return undefined
            const { grants, revokes, revokesByGrant } = encodeMigrationAuthorizationTxs(request)
            return {
              preTxs: grants,
              walletContext: { account: request.owner, chainId: request.chainId },
              postTxs: revokes,
              postTxsByPreTx: revokesByGrant,
            }
          },
          // Bundled counterpart for Safe execution: the simulation-variant
          // plan validates the grant instead of reading the live allowance,
          // so nothing needs to mine before the proposal is assembled. The
          // review rows come from the SAME resolution so the modal cannot
          // display a ceremony other than the one that executes.
          buildBundledExecution: async (account: Account<IHasVaultAddress>) => {
            const request = await getAuthorizationRequest(input, migrationPosition, account, useSignatures)
            const { grants, revokes } = request
              ? encodeMigrationAuthorizationTxs(request)
              : { grants: [], revokes: [] }
            const simulation = await buildMigrationSimulation(input, migrationPosition, request, account)
            return {
              plan: simulation.plan,
              grants,
              revokes,
              grantSteps: buildMigrationAuthorizationTxSteps(request, 'grant', 1, { bundled: true }),
              revokeSteps: buildMigrationAuthorizationTxSteps(request, 'revoke', 1, { bundled: true }),
            }
          },
        }),
    stateOverrides: preview.tenderlySimulation.stateOverrides,
    subAccount: migrationAccount.value,
    refreshExternalMigrationPositions: true,
    closedPositions: [
      { subAccount: migrationAccount.value, vault: sourceDebtVault.value.address as Address },
      { subAccount: migrationAccount.value, vault: sourceCollateralEVault.value.address as Address },
    ],
    review: {
      type: 'migration',
      asset: sourceDebtAsset,
      amount: debtAmount,
      // Batch prerequisites broadcast as standalone transactions
      // (sendPlainTransactions), never inside the cart's Safe bundle.
      signatureSteps: buildSignatureSteps(input.target, authorizationRequest, useSignatures, false),
      postSteps: buildRevokeSteps(authorizationRequest, useSignatures, false),
      displayPlan: preview.calldataPrepared.plan,
      calldataUsesPlaceholderSignatures: useSignatures && !!authorizationRequest,
    },
  }

  await addBatchEntry({
    ...batchEntry,
    buildPlan: async (account: Account<IHasVaultAddress>) => {
      // The preview was warmed against the fresh owner account. For the first
      // batch entry the planning account is that same account, so reuse the
      // prewarmed plan instead of re-running the full cross-protocol migration
      // simulation (position resolve → plan build). Only re-simulate when the
      // batch already has entries, where the planning account is a later layer
      // the prewarm didn't account for.
      if (!isBatchActive.value) {
        return {
          plan: preview.tenderlySimulation.plan,
          stateOverrides: preview.tenderlySimulation.stateOverrides,
        }
      }
      const simulationAuthorizationRequest = await getAuthorizationRequest(
        input,
        migrationPosition,
        account,
        useSignatures,
      )
      const simulationResult = await buildMigrationSimulation(
        input,
        migrationPosition,
        simulationAuthorizationRequest,
        account,
      )
      return {
        plan: simulationResult.plan,
        stateOverrides: simulationResult.stateOverrides,
      }
    },
  })
  redirectAfterAdd('/portfolio', {
    subAccount: migrationAccount.value,
    vault: sourceDebtVault.value.address,
    collateral: sourceCollateralEVault.value.address,
    removed: true,
  })
}

function flattenAuthorizationRequests(request: MigrationAuthorizationRequest | undefined): MigrationAuthorizationRequest[] {
  if (!request) return []
  return [
    request,
    ...flattenAuthorizationRequests(request.postMigrationAuthorization),
  ]
}

function buildSignatureSteps(
  target: OutgoingMigrationTarget | undefined,
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  useSignatures: boolean,
  bundled: boolean,
): DisplayStep[] {
  if (!authorizationRequest || !target) return []
  if (!useSignatures) {
    return buildMigrationAuthorizationTxSteps(authorizationRequest, 'grant', 1, { bundled })
  }
  if (target.connectorId === AAVE_CONNECTOR_ID) {
    return [{
      index: 1,
      label: 'Signature: Aave debt delegation',
      isSeparateTx: false,
    }]
  }
  return flattenAuthorizationRequests(authorizationRequest).map((request, index) => ({
    index: index + 1,
    label: request.kind === 'typedData' && request.typedData.message.isAuthorized === false
      ? 'Signature: disable Morpho authorization'
      : 'Signature: enable Morpho authorization',
    isSeparateTx: false,
  }))
}

/** Rows for the revoke transactions sent after the batch settles. */
function buildRevokeSteps(
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  useSignatures: boolean,
  bundled: boolean,
): DisplayStep[] {
  if (!authorizationRequest || useSignatures) return []
  return buildMigrationAuthorizationTxSteps(authorizationRequest, 'revoke', 1, { bundled })
}

function targetLiquidityDisplay(target: OutgoingMigrationTarget): string {
  const liquidityUsd = targetLiquidityUsdById.value[target.id]
  if (typeof liquidityUsd === 'number') {
    return formatCompactUsdValue(liquidityUsd)
  }
  if (!target.liquidity) return '-'
  if (isAaveTarget(target) && liquidityUsd === undefined) return '-'
  return formatTargetAmount(target.liquidity.amount, target.debt)
}

function formatTargetAmount(amount: bigint, asset: MigrationTargetAssetLike): string {
  const symbol = asset.symbol || sourceDebtVault.value?.asset.symbol || ''
  const decimals = asset.decimals ?? sourceDebtVault.value?.asset.decimals ?? 18
  return `${formatSmartAmount(formatUnits(amount, Number(decimals)))} ${symbol}`.trim()
}

function formatVaultAmount(
  amount: bigint | null | undefined,
  vault?: { asset?: { decimals: number | bigint | string } },
): string {
  if (amount === null || amount === undefined || !vault?.asset) return ''
  return trimTrailingZeros(formatUnits(amount, Number(vault.asset.decimals)))
}

function targetRowAriaLabel(target: OutgoingMigrationTarget): string {
  return `${targetPairLabel(target)} on ${targetProtocolDisplay(target)}, available liquidity ${targetLiquidityDisplay(target)}`
}

function targetActionAriaLabel(target: OutgoingMigrationTarget, action: 'migrate' | 'batch'): string {
  const verb = action === 'migrate' ? 'Migrate' : 'Add to batch'
  return `${verb} ${sourcePairLabel.value} position to ${targetProtocolDisplay(target)}`
}

function schedulePostMigrationRefreshes() {
  const refreshAddress = address.value || ''
  scheduleExternalMigrationRefreshes()
  for (const delay of POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS) {
    setTimeout(() => {
      if (refreshAddress) {
        void refreshAllPositions(undefined, refreshAddress)
      }
    }, delay)
  }
}

function sameAssetAddress(a?: string, b?: string): boolean {
  const first = normalizeAddressKey(a)
  const second = normalizeAddressKey(b)
  return !!first && !!second && first === second
}

function normalizeAddressKey(value?: string): string {
  if (!value) return ''
  try {
    return getAddress(value).toLowerCase()
  }
  catch {
    return value.toLowerCase()
  }
}
</script>

<template>
  <section class="relative flex justify-center min-h-[calc(100dvh-178px)]">
    <template v-if="isPositionsLoading">
      <div class="h-[calc(100dvh-178px)] flex items-center justify-center">
        <UiLoader class="text-neutral-500" />
      </div>
    </template>
    <template v-else-if="position">
      <div class="migrate-position">
        <BackButton
          class="hidden tablet:inline-flex tablet:absolute tablet:top-2 tablet:right-full tablet:mr-12"
          :fallback="positionDetailsFallback"
          always-fallback
        />
        <BackButton
          class="tablet:hidden"
          :fallback="positionDetailsFallback"
          always-fallback
        />

        <div class="migrate-position__header">
          <h1 class="text-p1 text-content-primary">
            Migrate from Euler
          </h1>
          <p class="text-p3 text-content-secondary">
            Move collateral and debt together to a compatible external market.
          </p>
        </div>

        <section class="flex flex-col gap-12">
          <h2 class="text-h5 text-content-primary">
            Source
          </h2>
          <div
            class="rounded-12 border border-line-default bg-card p-12"
            role="group"
            :aria-label="sourcePositionAriaLabel"
          >
            <PortfolioBorrowItem
              class="w-full"
              :position="position"
              :clickable="false"
            />
          </div>
        </section>

        <section class="flex flex-col gap-12">
          <h2 class="text-h5 text-content-primary">
            Select target protocol and market
          </h2>

          <UiAlert
            v-if="pageDisabledReason"
            title="Migration"
            :description="pageDisabledReason"
            variant="warning"
            size="compact"
          />

          <UiAlert
            v-if="targetsError"
            title="Migration targets"
            :description="targetsError"
            variant="warning"
            size="compact"
          />

          <div
            v-if="isTargetsLoading"
            class="migrate-position__targets"
            aria-label="Loading migration targets"
          >
            <div
              v-for="index in 3"
              :key="index"
              class="migrate-position__target-row migrate-position__target-row--skeleton"
            >
              <span class="migrate-position__skeleton migrate-position__skeleton--pair" />
              <span class="migrate-position__skeleton migrate-position__skeleton--value" />
              <span class="migrate-position__skeleton migrate-position__skeleton--actions" />
            </div>
          </div>

          <UiAlert
            v-else-if="noTargetsFound"
            title="No compatible targets"
            description="No supported Aave v3 or Morpho market matches this collateral and debt asset pair."
            variant="warning"
            size="compact"
          />

          <div
            v-else-if="targets.length"
            class="migrate-position__targets"
          >
            <article
              v-for="target in targets"
              :key="target.id"
              class="migrate-position__target-row"
              role="group"
              :aria-label="targetRowAriaLabel(target)"
            >
              <div class="migrate-position__target-pair">
                <AssetAvatar
                  :asset="targetAvatarAssets(target)"
                  size="28"
                />
                <div class="migrate-position__target-meta">
                  <div class="migrate-position__protocol-row">
                    <span>{{ target.protocol }}</span>
                    <span
                      v-if="targetMarketLabel(target)"
                      class="migrate-position__market-pill"
                    >
                      {{ targetMarketLabel(target) }}
                    </span>
                  </div>
                  <div class="migrate-position__pair-symbols">
                    <template v-if="isAaveTarget(target)">
                      <span class="migrate-position__pair-asset">
                        <span class="migrate-position__pair-text">{{ targetAssetSymbol(target, 'collateral') }}</span>
                        <a
                          v-if="aaveAssetExternalLink(target, 'collateral')"
                          class="migrate-position__target-external-link"
                          :href="aaveAssetExternalLink(target, 'collateral')!.href"
                          target="_blank"
                          rel="noopener noreferrer"
                          :aria-label="aaveAssetExternalLink(target, 'collateral')!.label"
                          :title="aaveAssetExternalLink(target, 'collateral')!.label"
                          @click.stop
                        >
                          <SvgIcon
                            name="arrow-top-right"
                            class="!w-14 !h-14"
                          />
                        </a>
                      </span>
                      <span class="migrate-position__pair-separator">/</span>
                      <span class="migrate-position__pair-asset">
                        <span class="migrate-position__pair-text">{{ targetAssetSymbol(target, 'debt') }}</span>
                        <a
                          v-if="aaveAssetExternalLink(target, 'debt')"
                          class="migrate-position__target-external-link"
                          :href="aaveAssetExternalLink(target, 'debt')!.href"
                          target="_blank"
                          rel="noopener noreferrer"
                          :aria-label="aaveAssetExternalLink(target, 'debt')!.label"
                          :title="aaveAssetExternalLink(target, 'debt')!.label"
                          @click.stop
                        >
                          <SvgIcon
                            name="arrow-top-right"
                            class="!w-14 !h-14"
                          />
                        </a>
                      </span>
                    </template>
                    <template v-else>
                      <span class="migrate-position__pair-text">{{ targetPairLabel(target) }}</span>
                      <a
                        v-for="link in targetExternalLinks(target)"
                        :key="link.href"
                        class="migrate-position__target-external-link"
                        :href="link.href"
                        target="_blank"
                        rel="noopener noreferrer"
                        :aria-label="link.label"
                        :title="link.label"
                        @click.stop
                      >
                        <SvgIcon
                          name="arrow-top-right"
                          class="!w-14 !h-14"
                        />
                      </a>
                    </template>
                  </div>
                </div>
              </div>

              <div class="migrate-position__liquidity">
                <div class="migrate-position__cell-label">
                  Available liquidity
                </div>
                <div class="migrate-position__cell-value">
                  {{ targetLiquidityDisplay(target) }}
                </div>
              </div>

              <div class="migrate-position__actions">
                <span
                  class="migrate-position__action-tooltip"
                  :title="getTargetMigrateDisabledReason(target) || undefined"
                >
                  <UiButton
                    class="migrate-position__migrate-button"
                    size="medium"
                    variant="primary"
                    :disabled="!canReviewTarget(target)"
                    :loading="reviewingTargetId === target.id"
                    :aria-label="targetActionAriaLabel(target, 'migrate')"
                    @click="reviewMigration(target)"
                  >
                    Migrate
                  </UiButton>
                </span>
                <span
                  class="migrate-position__action-tooltip"
                  :title="getTargetDisabledReason(target) || undefined"
                >
                  <UiButton
                    size="medium"
                    variant="secondary"
                    :disabled="!!batchingTargetId || !canAddToBatchTarget(target)"
                    :loading="batchingTargetId === target.id"
                    :aria-label="targetActionAriaLabel(target, 'batch')"
                    @click="addMigrationToBatch(target)"
                  >
                    Add to batch
                  </UiButton>
                </span>
              </div>
            </article>
          </div>
        </section>
      </div>
    </template>
    <template v-else>
      <div class="migrate-position migrate-position__empty text-p3 text-content-tertiary">
        Position not found
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.migrate-position {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1080px;
  padding: 0 24px 96px;

  &__header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__targets {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__target-row {
    display: grid;
    grid-template-columns: 1.6fr 1fr 232px;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    background: var(--bg-card);
    box-shadow: var(--shadow-card);
    transition:
      border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);

    &:hover {
      border-color: var(--border-emphasis);
      box-shadow: var(--shadow-card-hover);
    }
  }

  &__target-row--skeleton {
    pointer-events: none;
  }

  &__action-tooltip {
    display: inline-flex;
  }

  &__target-pair {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  &__target-meta {
    min-width: 0;
  }

  &__protocol-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 3px;
    color: var(--text-tertiary);
    font-size: 14px;
    line-height: 20px;
  }

  &__market-pill {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 2px 9px;
    border: 1px solid var(--border-default);
    border-radius: 8px;
    color: var(--text-secondary);
    background: var(--bg-surface-secondary);
    font-size: 13px;
    line-height: 18px;
    white-space: nowrap;
  }

  &__pair-symbols {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 16px;
    line-height: 20px;
    font-weight: 600;

  }

  &__pair-asset {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }

  &__pair-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__pair-separator {
    flex: 0 0 auto;
    color: var(--text-tertiary);
  }

  &__target-external-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--text-tertiary);
    transition: color 0.15s ease;

    &:hover {
      color: var(--text-primary);
    }
  }

  &__liquidity {
    min-width: 0;
  }

  &__cell-label {
    margin-bottom: 4px;
    color: var(--text-tertiary);
    font-size: 12px;
    line-height: 16px;
  }

  &__cell-value {
    color: var(--text-primary);
    font-size: 16px;
    line-height: 20px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;

    :deep(.ui-button) {
      white-space: nowrap;
    }

    :deep(.ui-button--primary:active) {
      transform: scale(0.98);
    }
  }

  &__migrate-button {
    min-width: 82px;
  }

  &__skeleton {
    display: block;
    min-height: 20px;
    border-radius: 8px;
    background: linear-gradient(
      90deg,
      var(--bg-surface-secondary) 0%,
      var(--bg-surface-elevated) 50%,
      var(--bg-surface-secondary) 100%
    );
    background-size: 200% 100%;
    animation: migrate-position-shimmer 1.2s ease-in-out infinite;
  }

  &__skeleton--pair {
    width: 64%;
  }

  &__skeleton--value {
    width: 44%;
  }

  &__skeleton--actions {
    width: 100%;
    min-height: 36px;
  }

  &__empty {
    justify-content: center;
    min-height: 240px;
  }
}

@media (max-width: 900px) {
  .migrate-position {
    padding-right: 16px;
    padding-left: 16px;

    &__target-row {
      grid-template-columns: 1fr 1fr;
      row-gap: 14px;
    }

    &__target-pair {
      grid-column: 1 / -1;
    }

    &__actions {
      grid-column: 1 / -1;

      :deep(.ui-button) {
        flex: 1;
      }
    }
  }
}

@keyframes migrate-position-shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: -100% 0;
  }
}
</style>
