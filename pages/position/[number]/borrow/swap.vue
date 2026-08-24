<script setup lang="ts">
import {
  type Account,
  type IHasVaultAddress,
  isEulerEarn,
  isEVault,
  isSecuritizeCollateralVault,
  SwapperMode,
  type EVault,
  type EulerEarn,
  type EulerMigrationTarget,
  type MigrationAuthorizationRequest,
  type MigrationPosition,
  type PluginPrefetchData,
  type PlanMigrationSimulationResult,
  type PortfolioBorrowPosition,
  type SecuritizeCollateralVault,
  type SwapQuote,
  type TransactionPlan,
  type TransactionPlanPrepared,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { erc20Abi, formatUnits, getAddress, maxUint256, zeroAddress, type Address, type StateOverride } from 'viem'
import { SlippageSettingsModal } from '#components'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { AAVE_CONNECTOR_ID, METAMORPHO_CONNECTOR_ID, MORPHO_CONNECTOR_ID } from '~/entities/migration/constants'
import { useSwapDebtOptions } from '~/composables/useSwapDebtOptions'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { useSwapQuotesParallel, type SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import { useReactiveMap } from '~/composables/useReactiveMap'
import type { PlanRefinancePositionInput } from '~/composables/useEulerTx'
import { getNewSubAccount } from '~/composables/useSubAccounts'
import type { CowSwapCollateralSwapExecuteParams } from '~/composables/cowswap'
import { useCowSwapCollateralSwapExecution, useCowSwapOrderStatus, openCowSwapReviewModal, buildApprovalSignSteps } from '~/composables/cowswap'
import { POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS, useExternalMigrationPositions, type ExternalMigrationCandidate } from '~/composables/useExternalMigrationPositions'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { buildSwapRouteItems } from '~/utils/swapRouteItems'
import { getQuoteAmount, getSwapInputAmount } from '~/utils/swapQuotes'
import { isSameUnderlyingAsset, convertVaultSharesToAssets } from '~/utils/vault-utils'
import { getRefinanceSlippageContext, type RefinanceSlippageLeg } from '~/utils/refinance-slippage'
import { buildRefinanceProjectedRateRequests, getRefinanceRewardCollateralAddresses, getSameAssetRefinanceBorrowAmount, resolveRefinanceCollateralLegs } from '~/utils/refinance-apy'
import { getAssetUsdValue, getAssetUsdValueForEstimate, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatioNumber } from '~/utils/sdk-prices'
import { withProjectedVaultIntrinsicApy, withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { isRoeStateApplicable } from '~/utils/position-roe'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros, formatUsdValue } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { areProjectedRatesComplete, getPositionMultiplier, getProjectedRatesBatch, type ProjectedRates } from '~/utils/vault/apy'
import { createRaceGuard } from '~/utils/race-guard'
import { ltvToPercent, nanoToValue } from '~/utils/crypto-utils'
import { getVaultProductName, isEarnVaultNotExplorable, isVaultNotExplorableLend } from '~/utils/eulerLabelsUtils'
import { buildCollateralOption, computeBorrowApy, computeSupplyApy } from '~/utils/collateralOptions'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { getPlanHookDisabledWarning } from '~/composables/useVaultWarnings'
import type { DisplayStep } from '~/utils/stepDecoding'
import {
  buildMigrationAuthorizationTxSteps,
} from '~/utils/migrationAuthorizationTxs'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  COWSWAP_PROVIDER_EXTRA_DATA,
  buildCollateralSwapQuoteAppData,
  getCowSwapChainConfig,
  getCowSwapQuoteOrderAmounts,
  isCowProviderOrQuote,
} from '~/entities/cowswap'
import { MODAL_CLOSE_REDIRECT_DELAY_MS } from '~/entities/tuning-constants'
import {
  isOpDisabled,
  OP_BORROW,
  OP_DEPOSIT,
  OP_REDEEM,
  OP_REPAY,
  OP_REPAY_WITH_SHARES,
  OP_SKIM,
  OP_WITHDRAW,
  type PlannedOp,
} from '~/utils/vault-hooks'
import { logWarn } from '~/utils/errorHandling'
import { isOperationBlocked, registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { BATCH_ACTIVE_REASON } from '~/utils/tx-batch-messages'
import type { CollateralOption } from '~/types/collateral-option'
import {
  getProjectedYieldState,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldCampaignInput,
  type ProjectedYieldDetails,
  type ProjectedYieldRateLine,
  type ProjectedYieldState,
} from '~/utils/projected-yield'
import { getLayeredVault } from '~/composables/useLayeredVaults'

const route = useRoute()
const router = useRouter()
const modal = useModal()
const { error: showError, warning: showWarning } = useToast()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const { isPositionsLoaded, isPositionsLoading, getPositionBySubAccountIndex, refreshAllPositions } = useEulerAccount()
const { chainId: currentChainId, eulerPeripheryAddresses } = useEulerAddresses()
const { client: rpcClient } = useRpcClient()
const {
  planRefinancePosition,
  getMigrationPosition,
  getMigrationAuthorization,
  buildPlaceholderMigrationAuthorization,
  planCrossProtocolMigration,
  planCrossProtocolMigrationSimulation,
  prepareTransactionPlan,
  prefetchPluginData,
} = useEulerTx()
const { open: openReviewState } = useExecutionReview()
const { create: createIntent } = useOperationIntentFactory()
const { createMigrationIntent } = useMigrationIntentFactory()
const { signaturesEnabled } = useSignaturePreference()
const { isSafeWallet } = useSafeWallet()
const { addEntry: addBatchEntry, entryCount: batchEntryCount } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { scheduleExternalMigrationRefreshes } = useExternalMigrationRefresh()
const { account: planAccount } = usePlanAccount()
const { primeSlotHintsFor, buildStateOverrideOptions } = useStateOverrideOptions()
const { runPreparedSimulation, runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { settings } = useUserSettings()
const {
  getSupplyRewardApy,
  getSupplyRewardCampaigns,
  getBorrowRewardApyForCollaterals,
  getBorrowRewardCampaignsForCollaterals,
  getEligibleLoopingRewardApyForCollaterals,
  getEligibleLoopingRewardCampaignsForCollaterals,
  version: rewardsVersion,
} = useRewardsApy()
const { viewer } = useApyVisibility()
const { getTokenCategoryTags } = useTokenList()
const { borrowList } = useVaults()
const { getVaultCategory, getVault, getVerifiedEVaults, getEarnVaults } = useVaultRegistry()
const showAllLabelEntries = useShowAllLabelEntries()
const cowSwapExecution = useCowSwapCollateralSwapExecution()
const cowSwapOrderStatus = useCowSwapOrderStatus(
  computed(() => cowSwapExecution.orderUid.value),
  currentChainId,
)
const chainId = currentChainId

const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
const positionIndex = usePositionIndex()
const externalSourceId = computed(() => typeof route.query.source === 'string' ? route.query.source : '')
const isExternalSourceRoute = computed(() => positionIndex === 'external' && !!externalSourceId.value)
const migrateDiscoveryPath = computed(() => {
  const network = typeof route.query.network === 'string' ? route.query.network : ''
  return network ? `/portfolio/migrate?network=${network}` : '/portfolio/migrate'
})
const refinanceBackFallback = computed(() =>
  isExternalSourceRoute.value ? migrateDiscoveryPath.value : positionDetailsFallback.value,
)
// A direct link to the external route without a source id has no position to
// render — fail closed to migration discovery instead of showing an empty
// refinance shell (mirrors usePositionIndex's redirect for invalid indices).
if (positionIndex === 'external' && !externalSourceId.value) {
  void router.replace(migrateDiscoveryPath.value)
}
const {
  positions: externalPositions,
  owner: inboundExternalOwner,
  isLoading: isExternalPositionsLoading,
  error: externalPositionsError,
  load: loadExternalPositions,
} = useExternalMigrationPositions()
const inboundExternalEulerAccount = shallowRef<Address | null>(null)
const inboundExternalEulerAccountKey = ref('')

// Layer-aware: `getPositionBySubAccountIndex` follows the active batch layer's
// portfolio, so refinance debt/collateral inputs must stay reactive to it. A
// one-shot ref would combine simulated vault utilization with layer-0 balances.
const position = computed<PortfolioBorrowPosition<VaultEntity> | null>(() => {
  if (isExternalSourceRoute.value || (!isConnected.value && !isSpyMode.value)) return null
  return getPositionBySubAccountIndex(+positionIndex) || null
})
const isLoading = computed(() =>
  !isExternalSourceRoute.value
  && (isConnected.value || isSpyMode.value)
  && !isPositionsLoaded.value,
)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isAddingToBatch = ref(false)
const plan = shallowRef<TransactionPlan | null>(null)
const preparedPlan = shallowRef<TransactionPlanPrepared | null>(null)
const inboundExternalAuthorizationConnector = ref<string | null>(null)
const inboundExternalMigrationPreview = shallowRef<InboundExternalMigrationPreview | null>(null)

const externalPosition = computed<ExternalMigrationCandidate | undefined>(() => {
  if (!isExternalSourceRoute.value) return undefined
  const owner = inboundExternalOwner.value
  const activeChainId = chainId.value
  if (!owner || !activeChainId) return undefined
  return externalPositions.value.find(candidate =>
    candidate.id === externalSourceId.value
    && candidate.chainId === activeChainId
    && sameAssetAddress(candidate.owner, owner),
  )
})
const externalPositionKey = computed(() => {
  const source = externalPosition.value
  if (!source) return ''
  return `${source.chainId}:${normalizeVaultAddress(source.owner)}:${source.id}`
})
const externalCollateralAsset = computed(() => externalPosition.value?.collateral ?? null)
const externalDebtAsset = computed(() => externalPosition.value?.debt ?? null)
const inboundExternalOwnerMatchesSource = computed(() => {
  const owner = inboundExternalOwner.value
  const sourceOwner = externalPosition.value?.owner
  if (!owner || !sourceOwner) return true
  return sameAssetAddress(owner, sourceOwner)
})
const externalIsSupplyOnly = computed(() => isExternalSourceRoute.value && !externalDebtAsset.value)
const externalCollateralVaultLabel = computed(() => externalIsSupplyOnly.value ? 'Lend vault' : 'Collateral vault')
const externalCollateralVaultPlaceholder = computed(() => externalIsSupplyOnly.value ? 'Select lend vault' : 'Select collateral vault')
const externalCollateralOptionsEmptyTitle = computed(() => externalIsSupplyOnly.value ? 'No lend options' : 'No collateral options')
const externalCollateralCompatibleLabel = computed(() => {
  if (!externalIsSupplyOnly.value) return undefined
  const symbol = externalCollateralAsset.value?.symbol
  return symbol ? `${symbol} vaults` : 'Same asset vaults'
})
const externalCollateralIncompatibleLabel = computed(() =>
  externalIsSupplyOnly.value ? 'Other vaults' : undefined,
)
const externalCollateralCompatibleEmptyMessage = computed(() =>
  externalIsSupplyOnly.value ? 'No compatible vaults exist, but you can swap.' : undefined,
)
const externalCollateralOptionsEmptyDescription = computed(() =>
  externalIsSupplyOnly.value
    ? 'There are no Euler lend vaults available for this external supply position.'
    : 'There are no Euler collateral vaults with compatible configuration for this external position.',
)
const inboundBorrowAmountWithBuffer = computed(() => {
  const debt = externalDebtAsset.value?.amount ?? 0n
  return getSameAssetRefinanceBorrowAmount(debt, true)
})
const externalSourcePairLabel = computed(() => {
  const collateral = externalCollateralAsset.value?.symbol ?? ''
  const debt = externalDebtAsset.value?.symbol ?? ''
  return debt ? `${collateral}/${debt}` : `${collateral} supply`
})
const toExternalInputAsset = (asset?: ExternalMigrationCandidate['collateral'] | null) => ({
  address: asset?.address ?? zeroAddress,
  name: asset?.symbol || 'Asset',
  symbol: asset?.symbol || '',
  decimals: asset?.decimals ?? 18,
})
const externalCollateralInputAsset = computed(() =>
  targetCollateralVault.value?.asset ?? toExternalInputAsset(externalCollateralAsset.value),
)
const externalDebtInputAsset = computed(() =>
  targetDebtVault.value?.asset ?? toExternalInputAsset(externalDebtAsset.value),
)
const externalCollateralVaultDescription = computed(() =>
  targetCollateralVault.value ? getVaultDisplayName(targetCollateralVault.value) : undefined,
)
const externalDebtVaultDescription = computed(() =>
  targetDebtVault.value ? getVaultDisplayName(targetDebtVault.value) : undefined,
)

const sourceDebtVault = computed<EVault | undefined>(() =>
  !isExternalSourceRoute.value && position.value ? position.value.borrowVault as EVault | undefined : undefined,
)
const selectedCollateralAddress = computed(() =>
  typeof route.query.collateral === 'string' ? normalizeVaultAddress(route.query.collateral) : '',
)
const positionDetailsFallback = computed(() => {
  const query = new URLSearchParams()
  const network = route.query.network
  if (typeof network === 'string') query.set('network', network)
  else if (Array.isArray(network) && network[0]) query.set('network', network[0])
  const search = query.toString()
  return `/position/${positionIndex}${search ? `?${search}` : ''}`
})
const clearRouteQueryKeys = (keys: readonly string[]) => {
  const keysToClear = new Set(keys)
  const query = Object.fromEntries(
    Object.entries(route.query).filter(([key]) => !keysToClear.has(key)),
  )
  const hasChanges = Object.keys(query).length !== Object.keys(route.query).length
  if (!hasChanges) return

  void router.replace({
    path: route.path,
    query,
    hash: route.hash,
  })
}
const sourceCollateralVault = computed<EVault | SecuritizeCollateralVault | undefined>(() => {
  const currentPosition = position.value
  if (!currentPosition) return undefined

  if (selectedCollateralAddress.value) {
    const selectedCollateral = currentPosition.collaterals.find(collateral =>
      normalizeVaultAddress(collateral.vaultAddress) === selectedCollateralAddress.value
      || normalizeVaultAddress(collateral.vault?.address) === selectedCollateralAddress.value,
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
/** Collateral targets selectable on the external supply-only route — lend EVKs plus EulerEarn vaults. */
type SupplyTargetVault = EVault | EulerEarn

const targetDebtVault = ref<EVault | undefined>()
const targetCollateralVault = ref<SupplyTargetVault | undefined>()
/** Narrows the target collateral to an EVault for the EVK-only code paths (refinance, CoW swap, caps/hooks). */
const targetCollateralEVault = computed<EVault | undefined>(() =>
  isEVault(targetCollateralVault.value) ? targetCollateralVault.value : undefined,
)

const effectiveDebtVault = computed<EVault | undefined>(() => targetDebtVault.value || sourceDebtVault.value)
const effectiveCollateralVault = computed<EVault | EulerEarn | SecuritizeCollateralVault | undefined>(() =>
  targetCollateralVault.value || sourceCollateralVault.value,
)
// Debt/collateral option lists never pair with an EulerEarn collateral (Earn
// targets exist only on the supply-only route), so narrow to the EVault here.
const effectiveCollateralEVaultForOptions = computed<EVault | SecuritizeCollateralVault | undefined>(() =>
  targetCollateralEVault.value || sourceCollateralVault.value,
)
const effectiveCollateralAddressesForOptions = computed(() =>
  getRefinanceRewardCollateralAddresses(
    position.value?.collaterals ?? [],
    sourceCollateralVault.value?.address,
    targetCollateralEVault.value?.address,
  ),
)
const projectionSourceDebtVault = computed(() => {
  const fallback = sourceDebtVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
const projectionEffectiveDebtVault = computed(() => {
  const fallback = effectiveDebtVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
const projectionSourceCollateralVault = computed(() => {
  const fallback = sourceCollateralVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
const projectionTargetCollateralVault = computed(() => {
  const fallback = targetCollateralVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})

useOperationGuard(computed(() => [
  sourceDebtVault.value?.address,
  sourceCollateralVault.value?.address,
  targetDebtVault.value?.address,
  targetCollateralVault.value?.address,
].filter(Boolean)))

const pairAssetsLabel = usePositionPairLabel(position)
const externalDebtAmount = computed(() => externalDebtAsset.value?.amount ?? 0n)
const externalCollateralAmount = computed(() => externalCollateralAsset.value?.amount ?? 0n)
const currentDebt = computed(() =>
  isExternalSourceRoute.value ? externalDebtAmount.value : position.value?.borrowed || 0n,
)
const sourceCollateralPosition = computed(() => {
  const sourceAddress = normalizeVaultAddress(sourceCollateralVault.value?.address)
  if (!sourceAddress) return null
  const matchedCollateral = position.value?.collaterals.find(collateral =>
    normalizeVaultAddress(collateral.vaultAddress) === sourceAddress
    || normalizeVaultAddress(collateral.vault?.address) === sourceAddress,
  )
  if (matchedCollateral) return matchedCollateral
  const primaryCollateral = position.value?.collateral
  return primaryCollateral && normalizeVaultAddress(primaryCollateral.vaultAddress) === sourceAddress
    ? primaryCollateral
    : null
})
const currentCollateralAssets = computed(() =>
  isExternalSourceRoute.value ? externalCollateralAmount.value : sourceCollateralPosition.value?.assets ?? position.value?.supplied ?? 0n,
)
const currentCollateralShares = computed(() =>
  isExternalSourceRoute.value ? 0n : sourceCollateralPosition.value?.shares ?? 0n,
)
const subAccount = computed<Address>(() =>
  (isExternalSourceRoute.value ? inboundExternalOwner.value || zeroAddress : position.value?.subAccount || address.value || zeroAddress) as Address,
)
const cowSwapOwner = computed<Address>(() =>
  (address.value || (isSpyMode.value ? spyAddress.value : undefined) || zeroAddress) as Address,
)
// Migration authorization must be signed by a real connected wallet. Spy mode
// stays read-only (discovery/preview) and cannot sign, so it must not satisfy
// the review/execute gate — otherwise a spy-only user passes "Connect wallet to
// migrate" and fails later at signing.
const hasConnectedWallet = computed(() => isConnected.value)

const hasDebtChange = computed(() =>
  isExternalSourceRoute.value ? !!targetDebtVault.value && !!externalDebtAsset.value : !!targetDebtVault.value && !!sourceDebtVault.value,
)
const hasCollateralChange = computed(() =>
  isExternalSourceRoute.value ? !!targetCollateralVault.value && !!externalCollateralAsset.value : !!targetCollateralVault.value && !!sourceCollateralEVault.value,
)
const hasAnyChange = computed(() => hasDebtChange.value || hasCollateralChange.value)
const isSameDebtAsset = computed(() =>
  !!targetDebtVault.value && (
    isExternalSourceRoute.value
      ? sameAssetAddress(externalDebtAsset.value?.address, targetDebtVault.value.asset.address)
      : isSameUnderlyingAsset(sourceDebtVault.value, targetDebtVault.value)
  ),
)
const isSameCollateralAsset = computed(() =>
  !!targetCollateralVault.value && (
    isExternalSourceRoute.value
      ? sameAssetAddress(externalCollateralAsset.value?.address, targetCollateralVault.value.asset.address)
      : isSameUnderlyingAsset(sourceCollateralEVault.value, targetCollateralVault.value)
  ),
)
const debtNeedsSwap = computed(() => hasDebtChange.value && !isSameDebtAsset.value)
const collateralNeedsSwap = computed(() => hasCollateralChange.value && !isSameCollateralAsset.value)

const sourceCollateralIsEscrow = computed(() =>
  !!sourceCollateralVault.value && getVaultCategory(sourceCollateralVault.value.address) === 'escrow',
)
const collateralMigrationDisabledReason = computed(() => {
  const source = sourceCollateralVault.value
  const sourceEVault = sourceCollateralEVault.value
  if (!source) return null
  if (isSecuritizeCollateralVault(source)) {
    return 'Collateral migration is unavailable for Securitize collateral. You can still refinance the debt vault.'
  }
  if (sourceCollateralIsEscrow.value) {
    return 'Collateral migration is unavailable for escrow collateral. You can still refinance the debt vault.'
  }
  if (!sourceEVault) return null
  if (isOpDisabled(sourceEVault, OP_WITHDRAW) && isOpDisabled(sourceEVault, OP_REDEEM)) {
    return 'Collateral migration is unavailable while withdrawals are disabled on the source collateral vault.'
  }
  return null
})
const canChangeCollateral = computed(() => !collateralMigrationDisabledReason.value && !!sourceCollateralEVault.value)

const {
  borrowOptions: rawDebtTargetOptions,
  borrowVaults: rawDebtTargetVaults,
  allBorrowOptions: rawAllDebtTargetOptions,
  allBorrowVaults: rawAllDebtTargetVaults,
} = useSwapDebtOptions({
  collateralVault: effectiveCollateralEVaultForOptions,
  collateralAddresses: effectiveCollateralAddressesForOptions,
  currentBorrowVault: computed(() => sourceDebtVault.value),
})

const debtSourceOperationAllowed = (target: EVault) => {
  if (isExternalSourceRoute.value) return true
  const source = sourceDebtVault.value
  if (!source) return false
  if (isSameUnderlyingAsset(source, target)) {
    return !isOpDisabled(source, OP_SKIM) && !isOpDisabled(source, OP_REPAY_WITH_SHARES)
  }
  return !isOpDisabled(source, OP_REPAY)
}

const eligibleDebtTargetVaults = computed(() =>
  rawDebtTargetVaults.value.filter(vault =>
    debtSourceOperationAllowed(vault) && hasCompatibleCollateralChoiceForDebt(vault),
  ),
)
const eligibleDebtTargetAddressSet = computed(() =>
  new Set(eligibleDebtTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const debtBridgeTargetVaults = computed(() =>
  rawAllDebtTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return debtSourceOperationAllowed(vault)
      && hasCompatibleCollateralChoiceForDebt(vault)
      && !eligibleDebtTargetAddressSet.value.has(address)
  }),
)
const debtBridgeTargetAddressSet = computed(() =>
  new Set(debtBridgeTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const debtTargetVaults = computed(() => [
  ...(isExternalSourceRoute.value
    ? externalDebtTargetVaults.value
    : [
        ...eligibleDebtTargetVaults.value,
        ...debtBridgeTargetVaults.value,
      ]),
])
const debtCompatibilityWarning = computed(() => ({
  title: 'Collateral migration required',
  message: 'These don\'t accept your current collateral. Pick one only if you also move collateral to a compatible vault.',
}))
const debtTargetOptions = computed(() =>
  isExternalSourceRoute.value
    ? externalDebtTargetOptions.value
    : [
        ...rawDebtTargetOptions.value.filter(option =>
          option.vaultAddress && eligibleDebtTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
        ),
        ...rawAllDebtTargetOptions.value
          .filter(option =>
            option.vaultAddress && debtBridgeTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
          )
          .map(option => ({
            ...option,
            compatibilityWarning: debtCompatibilityWarning.value,
          })),
      ],
)

const {
  collateralOptions: rawCollateralTargetOptions,
  collateralVaults: rawCollateralTargetVaults,
  allCollateralOptions: rawAllCollateralTargetOptions,
  allCollateralVaults: rawAllCollateralTargetVaults,
} = useSwapCollateralOptions({
  currentVault: sourceCollateralEVault,
  liabilityVault: computed(() => effectiveDebtVault.value),
})

const uniqueVaults = <TVault extends EVault | EulerEarn | SecuritizeCollateralVault>(vaults: TVault[]): TVault[] => {
  const seen = new Set<string>()
  const result: TVault[] = []
  for (const vault of vaults) {
    const address = normalizeVaultAddress(vault.address)
    if (!address || seen.has(address)) continue
    seen.add(address)
    result.push(vault)
  }
  return result
}

const filterOptionsByVaults = (options: CollateralOption[], vaults: Array<EVault | EulerEarn | SecuritizeCollateralVault>) => {
  const byAddress = new Map(
    options
      .filter(option => option.vaultAddress)
      .map(option => [normalizeVaultAddress(option.vaultAddress), option]),
  )
  return vaults
    .map(vault => byAddress.get(normalizeVaultAddress(vault.address)))
    .filter((option): option is CollateralOption => !!option)
}

const withCompatibilityWarning = (
  options: CollateralOption[],
  warning: CollateralOption['compatibilityWarning'],
) => options.map(option => ({ ...option, compatibilityWarning: warning }))

const prioritizeVaultsByAsset = <TVault extends EVault | EulerEarn | SecuritizeCollateralVault>(
  vaults: TVault[],
  asset?: { address?: string } | null,
  enabled = true,
): TVault[] => {
  if (!enabled || !asset?.address) return vaults
  return [...vaults].sort((a, b) =>
    Number(sameAssetAddress(b.asset.address, asset.address))
    - Number(sameAssetAddress(a.asset.address, asset.address)),
  )
}

const externalSupplyOnlyTargetVaults = computed<SupplyTargetVault[]>(() => {
  if (!externalIsSupplyOnly.value) return []
  const borrowableAddresses = new Set(
    borrowList.value.map(pair => normalizeVaultAddress(pair.borrow.address)),
  )
  const lendVaults = getVerifiedEVaults(showAllLabelEntries.value).filter(vault =>
    (showAllLabelEntries.value || !isVaultNotExplorableLend(vault.address))
    && borrowableAddresses.has(normalizeVaultAddress(vault.address))
    && !isOpDisabled(vault, OP_DEPOSIT),
  )
  // Earn vaults have no hook-based op gating; geo/deprecation restrictions are
  // applied per option via getVaultTags in buildCollateralOption.
  const earnVaults = getEarnVaults().filter(vault =>
    showAllLabelEntries.value || !isEarnVaultNotExplorable(vault.address),
  )
  return [...lendVaults, ...earnVaults]
})

const externalSupplyOnlyTargetOptions = useReactiveMap(
  externalSupplyOnlyTargetVaults,
  [viewer, enableIntrinsicApy, enableRewardsApy],
  async (vault) => {
    const apy = computeSupplyApy(vault, viewer.value, {
      enableIntrinsicApy: enableIntrinsicApy.value,
      enableRewardsApy: enableRewardsApy.value,
    })
    return buildCollateralOption({
      vault,
      type: 'vault',
      amount: 0,
      priceAmount: 0,
      apy,
      tagContext: 'swap-target',
      showBalance: false,
    })
  },
)
const externalSupplyOnlySwapRequiredWarning = computed(() => ({
  title: 'Swap required',
  message: 'Migrate and swap',
}))

const externalInitialTargetPairs = computed(() => {
  const collateralAsset = externalCollateralAsset.value
  if (!isExternalSourceRoute.value || !collateralAsset) return []

  const debtAsset = externalDebtAsset.value
  const collateralVaults = debtAsset
    ? rawAllCollateralTargetVaults.value.filter(vault =>
        sameAssetAddress(vault.asset.address, collateralAsset.address),
      )
    : externalSupplyOnlyTargetVaults.value
  if (!debtAsset) {
    return collateralVaults.map(collateral => ({ collateral: collateral as SupplyTargetVault, debt: null as EVault | null }))
  }

  const debtVaults = rawAllDebtTargetVaults.value.filter(vault =>
    sameAssetAddress(vault.asset.address, debtAsset.address),
  )
  const pairs: Array<{ debt: EVault, collateral: SupplyTargetVault }> = []
  for (const debt of debtVaults) {
    for (const collateral of collateralVaults) {
      if (isDebtCollateralCompatible(debt, collateral)) {
        pairs.push({ debt, collateral })
      }
    }
  }
  return pairs
})

const externalInitialCompatibleDebtTargetVaults = computed(() =>
  uniqueVaults(externalInitialTargetPairs.value.map(pair => pair.debt).filter((vault): vault is EVault => !!vault)),
)
const externalInitialCompatibleCollateralTargetVaults = computed(() =>
  uniqueVaults(externalInitialTargetPairs.value.map(pair => pair.collateral)),
)
const externalInitialCompatibleDebtTargetAddressSet = computed(() =>
  new Set(externalInitialCompatibleDebtTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const externalInitialCompatibleCollateralTargetAddressSet = computed(() =>
  new Set(externalInitialCompatibleCollateralTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const hasExternalCompatibleCollateralChoiceForDebt = (debtVault: EVault) =>
  rawAllCollateralTargetVaults.value.some(collateralVault =>
    isDebtCollateralCompatible(debtVault, collateralVault),
  )
const hasExternalCompatibleDebtChoiceForCollateral = (collateralVault: EVault | SecuritizeCollateralVault) =>
  rawAllDebtTargetVaults.value.some(debtVault =>
    isDebtCollateralCompatible(debtVault, collateralVault),
  )
const externalInitialDebtBridgeTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalDebtAsset.value || !externalCollateralAsset.value) return []
  return rawAllDebtTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return hasExternalCompatibleCollateralChoiceForDebt(vault)
      && !externalInitialCompatibleDebtTargetAddressSet.value.has(address)
  })
})
const externalInitialCollateralBridgeTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalDebtAsset.value || !externalCollateralAsset.value) return []
  return rawAllCollateralTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return hasExternalCompatibleDebtChoiceForCollateral(vault)
      && !externalInitialCompatibleCollateralTargetAddressSet.value.has(address)
  })
})
const externalInitialDebtCompatibilityWarning = computed(() => ({
  title: 'Collateral vault selection required',
  message: 'These need a compatible collateral vault selection too. Swap quotes are fetched when the debt asset changes.',
}))
const externalInitialCollateralCompatibilityWarning = computed(() => ({
  title: 'Debt vault selection required',
  message: 'These need a compatible debt vault selection too. Swap quotes are fetched when the collateral asset changes.',
}))
const externalInitialDebtTargetVaults = computed(() => [
  ...externalInitialCompatibleDebtTargetVaults.value,
  ...externalInitialDebtBridgeTargetVaults.value,
])
const externalInitialCollateralTargetVaults = computed(() => [
  ...externalInitialCompatibleCollateralTargetVaults.value,
  ...externalInitialCollateralBridgeTargetVaults.value,
])
const externalInitialDebtTargetOptions = computed(() => [
  ...filterOptionsByVaults(rawAllDebtTargetOptions.value, externalInitialCompatibleDebtTargetVaults.value),
  ...withCompatibilityWarning(
    filterOptionsByVaults(rawAllDebtTargetOptions.value, externalInitialDebtBridgeTargetVaults.value),
    externalInitialDebtCompatibilityWarning.value,
  ),
])
const externalInitialCollateralTargetOptions = computed(() => {
  if (externalIsSupplyOnly.value) {
    const sourceAsset = externalCollateralAsset.value?.address
    return externalSupplyOnlyTargetOptions.value.map((option) => {
      if (sameAssetAddress(option.assetAddress, sourceAsset)) return option
      return {
        ...option,
        compatibilityWarning: externalSupplyOnlySwapRequiredWarning.value,
      }
    })
  }
  return [
    ...filterOptionsByVaults(rawAllCollateralTargetOptions.value, externalInitialCompatibleCollateralTargetVaults.value),
    ...withCompatibilityWarning(
      filterOptionsByVaults(rawAllCollateralTargetOptions.value, externalInitialCollateralBridgeTargetVaults.value),
      externalInitialCollateralCompatibilityWarning.value,
    ),
  ]
})
const externalSelectedDebtBridgeTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalDebtAsset.value || !targetCollateralVault.value) return []
  const compatibleAddressSet = new Set(rawDebtTargetVaults.value.map(vault => normalizeVaultAddress(vault.address)))
  return rawAllDebtTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return hasExternalCompatibleCollateralChoiceForDebt(vault)
      && !compatibleAddressSet.has(address)
  })
})
const externalSelectedCollateralBridgeTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalCollateralAsset.value || !targetDebtVault.value) return []
  const compatibleAddressSet = new Set(rawCollateralTargetVaults.value.map(vault => normalizeVaultAddress(vault.address)))
  return rawAllCollateralTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return hasExternalCompatibleDebtChoiceForCollateral(vault)
      && !compatibleAddressSet.has(address)
  })
})
const externalSelectedDebtCompatibilityWarning = computed(() => ({
  title: 'Collateral migration required',
  message: 'These don\'t accept the selected collateral. Pick one only if you also move collateral to a compatible vault.',
}))
const externalSelectedCollateralCompatibilityWarning = computed(() => ({
  title: 'Debt migration required',
  message: 'These aren\'t accepted by the selected debt. Pick one only if you also move debt to a compatible vault.',
}))
const selectedExternalCollateralStartedCompatible = computed(() =>
  !!targetCollateralVault.value
  && externalInitialCompatibleCollateralTargetAddressSet.value.has(normalizeVaultAddress(targetCollateralVault.value.address)),
)
const selectedExternalDebtStartedCompatible = computed(() =>
  !!targetDebtVault.value
  && externalInitialCompatibleDebtTargetAddressSet.value.has(normalizeVaultAddress(targetDebtVault.value.address)),
)
const externalSelectedCompatibleDebtTargetVaults = computed(() =>
  prioritizeVaultsByAsset(
    rawDebtTargetVaults.value,
    externalDebtAsset.value,
    selectedExternalCollateralStartedCompatible.value,
  ),
)
const externalSelectedCompatibleCollateralTargetVaults = computed(() =>
  prioritizeVaultsByAsset(
    rawCollateralTargetVaults.value,
    externalCollateralAsset.value,
    selectedExternalDebtStartedCompatible.value,
  ),
)
const externalSelectedDebtTargetVaults = computed(() => [
  ...externalSelectedCompatibleDebtTargetVaults.value,
  ...externalSelectedDebtBridgeTargetVaults.value,
])
const externalSelectedCollateralTargetVaults = computed(() => [
  ...externalSelectedCompatibleCollateralTargetVaults.value,
  ...externalSelectedCollateralBridgeTargetVaults.value,
])
const externalSelectedDebtTargetOptions = computed(() => [
  ...filterOptionsByVaults(rawDebtTargetOptions.value, externalSelectedCompatibleDebtTargetVaults.value),
  ...withCompatibilityWarning(
    filterOptionsByVaults(rawAllDebtTargetOptions.value, externalSelectedDebtBridgeTargetVaults.value),
    externalSelectedDebtCompatibilityWarning.value,
  ),
])
const externalSelectedCollateralTargetOptions = computed(() => [
  ...filterOptionsByVaults(rawCollateralTargetOptions.value, externalSelectedCompatibleCollateralTargetVaults.value),
  ...withCompatibilityWarning(
    filterOptionsByVaults(rawAllCollateralTargetOptions.value, externalSelectedCollateralBridgeTargetVaults.value),
    externalSelectedCollateralCompatibilityWarning.value,
  ),
])
const externalDebtTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalDebtAsset.value) return []
  return targetCollateralVault.value
    ? externalSelectedDebtTargetVaults.value
    : externalInitialDebtTargetVaults.value
})
const externalCollateralTargetVaults = computed(() => {
  if (!isExternalSourceRoute.value || !externalCollateralAsset.value) return []
  return targetDebtVault.value
    ? externalSelectedCollateralTargetVaults.value
    : externalInitialCollateralTargetVaults.value
})
const externalDebtTargetOptions = computed(() =>
  targetCollateralVault.value
    ? externalSelectedDebtTargetOptions.value
    : externalInitialDebtTargetOptions.value,
)
const externalCollateralTargetOptions = computed(() =>
  targetDebtVault.value
    ? externalSelectedCollateralTargetOptions.value
    : externalInitialCollateralTargetOptions.value,
)
const collateralSourceOperationAllowed = (target: EVault) => {
  if (isExternalSourceRoute.value) return true
  const source = sourceCollateralEVault.value
  if (!source) return false
  return isSameUnderlyingAsset(source, target)
    ? !isOpDisabled(source, OP_REDEEM)
    : !isOpDisabled(source, OP_WITHDRAW)
}

const hasCompatibleCollateralChoiceForDebt = (debtVault: EVault) => {
  const currentCollateral = sourceCollateralVault.value
  if (currentCollateral && isDebtCollateralCompatible(debtVault, currentCollateral)) {
    return true
  }
  if (!canChangeCollateral.value) return false
  return rawAllCollateralTargetVaults.value.some(collateralVault =>
    collateralSourceOperationAllowed(collateralVault)
    && isDebtCollateralCompatible(debtVault, collateralVault),
  )
}

const hasCompatibleDebtChoiceForCollateral = (collateralVault: EVault | SecuritizeCollateralVault) => {
  const currentDebt = sourceDebtVault.value
  if (currentDebt && isDebtCollateralCompatible(currentDebt, collateralVault)) {
    return true
  }
  return rawAllDebtTargetVaults.value.some(debtVault =>
    debtSourceOperationAllowed(debtVault)
    && isDebtCollateralCompatible(debtVault, collateralVault),
  )
}

const eligibleCollateralTargetVaults = computed(() => {
  if (!canChangeCollateral.value) return []
  return rawCollateralTargetVaults.value.filter(vault =>
    collateralSourceOperationAllowed(vault) && hasCompatibleDebtChoiceForCollateral(vault),
  )
})
const eligibleCollateralTargetAddressSet = computed(() =>
  new Set(eligibleCollateralTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const collateralBridgeTargetVaults = computed(() => {
  if (!canChangeCollateral.value) return []
  return rawAllCollateralTargetVaults.value.filter((vault) => {
    const address = normalizeVaultAddress(vault.address)
    return collateralSourceOperationAllowed(vault)
      && hasCompatibleDebtChoiceForCollateral(vault)
      && !eligibleCollateralTargetAddressSet.value.has(address)
  })
})
const collateralBridgeTargetAddressSet = computed(() =>
  new Set(collateralBridgeTargetVaults.value.map(vault => normalizeVaultAddress(vault.address))),
)
const collateralTargetVaults = computed(() => [
  ...(isExternalSourceRoute.value
    ? externalCollateralTargetVaults.value
    : [
        ...eligibleCollateralTargetVaults.value,
        ...collateralBridgeTargetVaults.value,
      ]),
])
const collateralCompatibilityWarning = computed(() => ({
  title: 'Debt migration required',
  message: 'These aren\'t accepted by your current debt. Pick one only if you also move debt to a compatible vault.',
}))
const collateralTargetOptions = computed(() =>
  isExternalSourceRoute.value
    ? externalCollateralTargetOptions.value
    : [
        ...rawCollateralTargetOptions.value.filter(option =>
          option.vaultAddress && eligibleCollateralTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
        ),
        ...rawAllCollateralTargetOptions.value
          .filter(option =>
            option.vaultAddress && collateralBridgeTargetAddressSet.value.has(normalizeVaultAddress(option.vaultAddress)),
          )
          .map(option => ({
            ...option,
            compatibilityWarning: collateralCompatibilityWarning.value,
          })),
      ],
)

const currentDebtOption = computed<CollateralOption | null>(() => {
  if (isExternalSourceRoute.value) return null
  const vault = sourceDebtVault.value
  if (!vault) return null
  const option = makeVaultOption(vault, fromBorrowApy.value ?? undefined, 'Keep current debt')
  if (targetCollateralVault.value && !isDebtCollateralCompatible(vault, targetCollateralVault.value)) {
    option.compatibilityWarning = debtCompatibilityWarning.value
  }
  return option
})
const debtSelectionOptions = computed(() => [
  ...(currentDebtOption.value ? [currentDebtOption.value] : []),
  ...debtTargetOptions.value,
])
const debtSelectionVaults = computed(() => [
  ...(sourceDebtVault.value ? [sourceDebtVault.value] : []),
  ...debtTargetVaults.value,
])

const currentCollateralOption = computed<CollateralOption | null>(() => {
  if (isExternalSourceRoute.value) return null
  const vault = sourceCollateralVault.value
  if (!vault) return null
  const option = makeVaultOption(vault, fromSupplyApy.value ?? undefined, 'Keep current collateral')
  if (targetDebtVault.value && !isDebtCollateralCompatible(targetDebtVault.value, vault)) {
    option.compatibilityWarning = collateralCompatibilityWarning.value
  }
  return option
})
const collateralSelectionOptions = computed(() => [
  ...(currentCollateralOption.value ? [currentCollateralOption.value] : []),
  ...collateralTargetOptions.value,
])
const collateralSelectionVaults = computed(() => [
  ...(sourceCollateralVault.value ? [sourceCollateralVault.value] : []),
  ...collateralTargetVaults.value,
])

const refinanceSlippageLegs = computed<RefinanceSlippageLeg[]>(() => {
  const legs: RefinanceSlippageLeg[] = []

  if (collateralNeedsSwap.value && targetCollateralVault.value) {
    const fromSymbol = isExternalSourceRoute.value
      ? externalCollateralAsset.value?.symbol
      : sourceCollateralEVault.value?.asset.symbol
    if (fromSymbol) {
      legs.push({
        fromSymbol,
        toSymbol: targetCollateralVault.value.asset.symbol,
      })
    }
  }

  if (debtNeedsSwap.value && targetDebtVault.value) {
    const toSymbol = isExternalSourceRoute.value
      ? externalDebtAsset.value?.symbol
      : sourceDebtVault.value?.asset.symbol
    if (toSymbol) {
      legs.push({
        fromSymbol: targetDebtVault.value.asset.symbol,
        toSymbol,
      })
    }
  }

  return legs
})
const refinanceSlippageContext = computed(() =>
  getRefinanceSlippageContext(refinanceSlippageLegs.value),
)

const { slippage } = useSlippage({
  fromSymbol: () => refinanceSlippageContext.value?.fromSymbol,
  toSymbol: () => refinanceSlippageContext.value?.toSymbol,
})

const buildRefinanceStateOverrideOptions = () => buildStateOverrideOptions({ noBalanceOverride: true })
const currentPlanAccount = () => planAccount.value
const planContextAccount = (context?: SwapQuotePlanContext) => context?.account ?? planAccount.value

type RefinancePlanOptions = {
  collateralQuote?: SwapQuote | null
  debtQuote?: SwapQuote | null
  includeIncomplete?: boolean
}

const buildRefinanceInput = (
  options: RefinancePlanOptions = {},
): Omit<PlanRefinancePositionInput, 'account'> => {
  if (!position.value || !sourceDebtVault.value || !sourceCollateralVault.value) {
    throw new Error('Position is not loaded')
  }

  const input: Omit<PlanRefinancePositionInput, 'account'> = {}

  if (hasCollateralChange.value) {
    if (!sourceCollateralEVault.value || !targetCollateralVault.value) {
      throw new Error('Collateral vaults are not loaded')
    }
    const quote = options.collateralQuote ?? selectedCollateralQuote.value
    if (!isSameCollateralAsset.value && !quote) {
      if (!options.includeIncomplete) throw new Error('No collateral quote selected')
    }
    else {
      input.collateral = {
        fromVault: sourceCollateralEVault.value.address as Address,
        toVault: targetCollateralVault.value.address as Address,
        amount: currentCollateralAssets.value,
        positionAccount: subAccount.value,
        fromAsset: sourceCollateralEVault.value.asset.address as Address,
        toAsset: targetCollateralVault.value.asset.address as Address,
        isMax: true,
        enableCollateralTo: true,
        disableCollateralFrom: true,
        swapQuote: isSameCollateralAsset.value ? undefined : quote!,
        swapperMode: SwapperMode.EXACT_IN,
      }
    }
  }

  if (hasDebtChange.value) {
    if (!targetDebtVault.value) {
      throw new Error('Debt vault is not loaded')
    }
    const quote = options.debtQuote ?? selectedDebtQuote.value
    if (!isSameDebtAsset.value && !quote) {
      if (!options.includeIncomplete) throw new Error('No debt quote selected')
    }
    else {
      input.debt = {
        oldLiabilityVault: sourceDebtVault.value.address as Address,
        newLiabilityVault: targetDebtVault.value.address as Address,
        liabilityAccount: subAccount.value,
        liabilityAmount: currentDebt.value,
        oldLiabilityAsset: sourceDebtVault.value.asset.address as Address,
        newLiabilityAsset: targetDebtVault.value.asset.address as Address,
        swapQuote: isSameDebtAsset.value ? undefined : quote!,
        swapperMode: SwapperMode.TARGET_DEBT,
      }
    }
  }

  if (!input.collateral && !input.debt) {
    throw new Error('No refinance changes selected')
  }

  return input
}

const buildRefinancePlan = async (
  options: {
    collateralQuote?: SwapQuote | null
    debtQuote?: SwapQuote | null
    includeIncomplete?: boolean
    context?: SwapQuotePlanContext
  } = {},
): Promise<TransactionPlan> => {
  const input: PlanRefinancePositionInput = {
    ...buildRefinanceInput(options),
    account: planContextAccount(options.context),
  }

  return planRefinancePosition(input)
}

const createRefinanceIntent = (
  input: Omit<PlanRefinancePositionInput, 'account'>,
  source: string,
) => createIntent({
  kind: 'refinance',
  planner: 'refinance-position',
  args: {
    collateral: input.collateral
      ? input.collateral.swapQuote
        ? {
            planner: 'swap-collateral',
            args: {
              swapQuote: input.collateral.swapQuote,
              swapperMode: input.collateral.swapperMode,
            },
          }
        : {
            planner: 'migrate-same-asset-collateral',
            args: input.collateral,
          }
      : undefined,
    debt: input.debt
      ? input.debt.swapQuote
        ? {
            planner: 'swap-debt',
            args: {
              swapQuote: input.debt.swapQuote,
              swapperMode: input.debt.swapperMode,
            },
          }
        : {
            planner: 'migrate-same-asset-debt',
            args: input.debt,
          }
      : undefined,
  },
  source,
  subAccounts: [subAccount.value as Address],
})

const { cowSwapForcedOff } = useCowSwapEligibility()

const canRequestCollateralCowSwap = computed(() =>
  !cowSwapForcedOff.value
  && collateralNeedsSwap.value
  && !hasDebtChange.value
  && currentCollateralShares.value > 0n
  && !!getCowSwapChainConfig(currentChainId.value ?? 0),
)

const buildCollateralCowProviderExtraData = () => {
  if (!sourceCollateralEVault.value || !targetCollateralVault.value) return undefined
  const chainConfig = getCowSwapChainConfig(currentChainId.value ?? 0)
  if (!chainConfig || currentCollateralShares.value <= 0n) return undefined

  const quoteDeadline = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
  return {
    ...COWSWAP_PROVIDER_EXTRA_DATA.collateralSwap(currentCollateralShares.value),
    appData: buildCollateralSwapQuoteAppData(
      {
        owner: cowSwapOwner.value,
        account: subAccount.value,
        deadline: quoteDeadline,
        fromVault: sourceCollateralEVault.value.address as Address,
        toVault: targetCollateralVault.value.address as Address,
        fromAmount: currentCollateralShares.value,
        disableSourceCollateral: true,
      },
      chainConfig.collateralSwapWrapper,
      Math.round(slippage.value * 100),
    ),
  }
}

const {
  sortedQuoteCards: collateralQuoteCardsSorted,
  selectedProvider: collateralSelectedProvider,
  selectedQuote: selectedCollateralQuote,
  effectiveQuote: collateralQuote,
  effectiveQuoteFetchedAt: collateralQuoteFetchedAt,
  isLoading: isCollateralQuoteLoading,
  quoteError: collateralQuoteError,
  statusLabel: collateralQuotesStatusLabel,
  getQuoteDiffPct: getCollateralQuoteDiffPct,
  reset: resetCollateralQuotes,
  requestQuotes: requestCollateralQuotesNow,
  selectProvider: selectCollateralProvider,
} = useSwapQuotesParallel({
  amountField: 'amountOut',
  compare: 'max',
  includeCowSwap: () => canRequestCollateralCowSwap.value,
  buildTxPlanForQuote: (quote, _provider, context) => buildRefinancePlan({
    collateralQuote: quote,
    debtQuote: selectedDebtQuote.value,
    includeIncomplete: true,
    context,
  }),
  createIntentsForQuote: quote => [createRefinanceIntent(buildRefinanceInput({
    collateralQuote: quote,
    debtQuote: selectedDebtQuote.value,
    includeIncomplete: true,
  }), 'position/refinance')],
  getPlanAccount: () => currentPlanAccount(),
  getStateOverrideOptions: () => buildRefinanceStateOverrideOptions(),
  prefetchPluginData: (candidatePlan, account, intents) => prefetchPluginData(candidatePlan, { account, intents }),
  prepareTransactionPlan: (candidatePlan, account, prefetch, intents) => prepareTransactionPlan(candidatePlan, { account, prefetch, intents }),
})

const {
  sortedQuoteCards: debtQuoteCardsSorted,
  selectedProvider: debtSelectedProvider,
  selectedQuote: selectedDebtQuote,
  effectiveQuote: debtQuote,
  effectiveQuoteFetchedAt: debtQuoteFetchedAt,
  isLoading: isDebtQuoteLoading,
  quoteError: debtQuoteError,
  statusLabel: debtQuotesStatusLabel,
  getQuoteDiffPct: getDebtQuoteDiffPct,
  reset: resetDebtQuotes,
  requestQuotes: requestDebtQuotesNow,
  selectProvider: selectDebtProvider,
} = useSwapQuotesParallel({
  amountField: 'amountIn',
  compare: 'min',
  buildTxPlanForQuote: (quote, _provider, context) => buildRefinancePlan({
    collateralQuote: selectedCollateralQuote.value,
    debtQuote: quote,
    includeIncomplete: true,
    context,
  }),
  createIntentsForQuote: quote => [createRefinanceIntent(buildRefinanceInput({
    collateralQuote: selectedCollateralQuote.value,
    debtQuote: quote,
    includeIncomplete: true,
  }), 'position/refinance')],
  getPlanAccount: () => currentPlanAccount(),
  getStateOverrideOptions: () => buildRefinanceStateOverrideOptions(),
  prefetchPluginData: (candidatePlan, account, intents) => prefetchPluginData(candidatePlan, { account, intents }),
  prepareTransactionPlan: (candidatePlan, account, prefetch, intents) => prepareTransactionPlan(candidatePlan, { account, prefetch, intents }),
})

const isSelectedCollateralCowSwapProvider = computed(() =>
  isCowProviderOrQuote(collateralSelectedProvider.value, selectedCollateralQuote.value),
)

const requestCollateralQuotes = useDebounceFn(async () => {
  if (!collateralNeedsSwap.value || !sourceCollateralEVault.value || !targetCollateralVault.value || currentCollateralAssets.value <= 0n) {
    resetCollateralQuotes()
    return
  }
  const providerExtraData = canRequestCollateralCowSwap.value
    ? buildCollateralCowProviderExtraData()
    : undefined
  await requestCollateralQuotesNow({
    tokenIn: sourceCollateralEVault.value.asset.address as Address,
    tokenOut: targetCollateralVault.value.asset.address as Address,
    accountIn: subAccount.value,
    accountOut: subAccount.value,
    amount: currentCollateralAssets.value,
    vaultIn: sourceCollateralEVault.value.address as Address,
    receiver: targetCollateralVault.value.address as Address,
    slippage: slippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
    providerExtraData,
  })
}, 500)

const requestDebtQuotes = useDebounceFn(async () => {
  if (!debtNeedsSwap.value || !sourceDebtVault.value || !targetDebtVault.value || currentDebt.value <= 0n) {
    resetDebtQuotes()
    return
  }
  await requestDebtQuotesNow({
    tokenIn: targetDebtVault.value.asset.address as Address,
    tokenOut: sourceDebtVault.value.asset.address as Address,
    accountIn: subAccount.value,
    accountOut: subAccount.value,
    amount: currentDebt.value,
    vaultIn: targetDebtVault.value.address as Address,
    receiver: sourceDebtVault.value.address as Address,
    slippage: slippage.value,
    swapperMode: SwapperMode.TARGET_DEBT,
    isRepay: true,
    targetDebt: 0n,
    currentDebt: currentDebt.value,
  })
}, 500)

const onRefreshCollateralQuotes = () => {
  resetCollateralQuotes()
  void requestCollateralQuotes()
}
const onRefreshDebtQuotes = () => {
  resetDebtQuotes()
  void requestDebtQuotes()
}

const collateralRouteItems = computed(() => {
  const vault = targetCollateralVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: collateralQuoteCardsSorted.value,
    getQuoteDiffPct: getCollateralQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountOut',
    compare: 'max',
    diffPrefix: '-',
  })
})
const debtRouteItems = computed(() => {
  const vault = targetDebtVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: debtQuoteCardsSorted.value,
    getQuoteDiffPct: getDebtQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountIn',
    compare: 'min',
    diffPrefix: '+',
  })
})
const swapRouteEmptyMessage = 'Enter amount to fetch quotes'

const {
  sortedQuoteCards: externalCollateralQuoteCardsSorted,
  selectedProvider: externalCollateralSelectedProvider,
  selectedQuote: selectedExternalCollateralQuote,
  effectiveQuote: externalCollateralQuote,
  effectiveQuoteFetchedAt: externalCollateralQuoteFetchedAt,
  isLoading: isExternalCollateralQuoteLoading,
  quoteError: externalCollateralQuoteError,
  statusLabel: externalCollateralQuotesStatusLabel,
  getQuoteDiffPct: getExternalCollateralQuoteDiffPct,
  reset: resetExternalCollateralQuotes,
  requestQuotes: requestExternalCollateralQuotesNow,
  selectProvider: selectExternalCollateralProvider,
} = useSwapQuotesParallel({
  amountField: 'amountOut',
  compare: 'max',
})

const {
  sortedQuoteCards: externalDebtQuoteCardsSorted,
  selectedProvider: externalDebtSelectedProvider,
  selectedQuote: selectedExternalDebtQuote,
  effectiveQuote: externalDebtQuote,
  effectiveQuoteFetchedAt: externalDebtQuoteFetchedAt,
  isLoading: isExternalDebtQuoteLoading,
  quoteError: externalDebtQuoteError,
  statusLabel: externalDebtQuotesStatusLabel,
  getQuoteDiffPct: getExternalDebtQuoteDiffPct,
  reset: resetExternalDebtQuotes,
  requestQuotes: requestExternalDebtQuotesNow,
  selectProvider: selectExternalDebtProvider,
} = useSwapQuotesParallel({
  amountField: 'amountIn',
  compare: 'min',
})

const externalQuoteOwner = computed<Address>(() =>
  (inboundExternalOwner.value || address.value || zeroAddress) as Address,
)

const inboundExternalAccountSeedVault = computed(() =>
  externalIsSupplyOnly.value
    ? undefined
    : targetDebtVault.value
      || externalInitialCompatibleDebtTargetVaults.value[0]
      || externalInitialDebtTargetVaults.value[0],
)

const resolveInboundExternalEulerAccount = async () => {
  if (!inboundExternalOwner.value) {
    throw new Error('Migration target account is incomplete')
  }
  const owner = getAddress(inboundExternalOwner.value) as Address
  if (externalIsSupplyOnly.value) {
    inboundExternalEulerAccount.value = owner
    inboundExternalEulerAccountKey.value = `${chainId.value ?? 'unknown'}:${owner}:${externalSourceId.value}:supply`
    return owner
  }

  const key = `${chainId.value ?? 'unknown'}:${owner}:${externalSourceId.value}`
  if (inboundExternalEulerAccount.value && inboundExternalEulerAccountKey.value === key) {
    return inboundExternalEulerAccount.value
  }

  const account = await getNewSubAccount(owner, inboundExternalAccountSeedVault.value?.address) as Address
  inboundExternalEulerAccount.value = account
  inboundExternalEulerAccountKey.value = key
  return account
}

const requestExternalCollateralQuotes = useDebounceFn(async () => {
  const sourceAsset = externalCollateralAsset.value
  const targetVault = targetCollateralVault.value
  const amount = externalCollateralAmount.value
  if (!isExternalSourceRoute.value || !collateralNeedsSwap.value || !sourceAsset || !targetVault || !inboundExternalOwner.value || amount <= 0n) {
    resetExternalCollateralQuotes()
    return
  }
  const eulerAccount = await resolveInboundExternalEulerAccount()
  // EulerEarn targets have no `skim`, so the swap output must be routed to the
  // SwapVerifier (transferOutputToReceiver) where the migration batch deposits
  // it via `verifyAmountMinAndDeposit` (collateralSwapVerification: 'deposit').
  const isEarnTarget = isEulerEarn(targetVault)
  const swapVerifier = eulerPeripheryAddresses.value?.swapVerifier
  if (isEarnTarget && !swapVerifier) {
    resetExternalCollateralQuotes()
    return
  }
  await requestExternalCollateralQuotesNow({
    tokenIn: sourceAsset.address as Address,
    tokenOut: targetVault.asset.address as Address,
    accountIn: zeroAddress as Address,
    // The swap API requires accountOut to be the zero address for
    // transferOutputToReceiver quotes (TransferMin verification).
    accountOut: isEarnTarget ? zeroAddress as Address : eulerAccount,
    amount,
    vaultIn: zeroAddress as Address,
    receiver: (isEarnTarget ? swapVerifier : targetVault.address) as Address,
    origin: externalQuoteOwner.value,
    slippage: slippage.value,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: false,
    targetDebt: 0n,
    currentDebt: 0n,
    unusedInputReceiver: externalQuoteOwner.value,
    ...(isEarnTarget ? { transferOutputToReceiver: true } : {}),
  })
}, 500)

const requestExternalDebtQuotes = useDebounceFn(async () => {
  const sourceDebt = externalDebtAsset.value
  const targetVault = targetDebtVault.value
  const swapper = eulerPeripheryAddresses.value?.swapper
  const amount = externalDebtAmount.value
  if (!isExternalSourceRoute.value || !debtNeedsSwap.value || !sourceDebt || !targetVault || !swapper || !inboundExternalOwner.value || amount <= 0n) {
    resetExternalDebtQuotes()
    return
  }
  const eulerAccount = await resolveInboundExternalEulerAccount()
  await requestExternalDebtQuotesNow({
    tokenIn: targetVault.asset.address as Address,
    tokenOut: sourceDebt.address as Address,
    accountIn: eulerAccount,
    accountOut: eulerAccount,
    amount,
    vaultIn: targetVault.address as Address,
    receiver: swapper as Address,
    origin: externalQuoteOwner.value,
    slippage: slippage.value,
    swapperMode: SwapperMode.TARGET_DEBT,
    isRepay: true,
    targetDebt: 0n,
    currentDebt: amount,
    skipSweepDepositOut: true,
  })
}, 500)

const onRefreshExternalCollateralQuotes = () => {
  resetExternalCollateralQuotes()
  void requestExternalCollateralQuotes()
}
const onRefreshExternalDebtQuotes = () => {
  resetExternalDebtQuotes()
  void requestExternalDebtQuotes()
}

const externalCollateralRouteItems = computed(() => {
  const vault = targetCollateralVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: externalCollateralQuoteCardsSorted.value,
    getQuoteDiffPct: getExternalCollateralQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountOut',
    compare: 'max',
    diffPrefix: '-',
  })
})
const externalDebtRouteItems = computed(() => {
  const vault = targetDebtVault.value
  if (!vault) return []
  return buildSwapRouteItems({
    quoteCards: externalDebtQuoteCardsSorted.value,
    getQuoteDiffPct: getExternalDebtQuoteDiffPct,
    decimals: Number(vault.asset.decimals),
    symbol: vault.asset.symbol,
    formatAmount: formatSmartAmount,
    amountField: 'amountIn',
    compare: 'min',
    diffPrefix: '+',
  })
})
const activeCollateralQuote = computed(() =>
  isExternalSourceRoute.value ? externalCollateralQuote.value : collateralQuote.value,
)
const activeDebtQuote = computed(() =>
  isExternalSourceRoute.value ? externalDebtQuote.value : debtQuote.value,
)
const activeSelectedCollateralQuote = computed(() =>
  isExternalSourceRoute.value ? selectedExternalCollateralQuote.value : selectedCollateralQuote.value,
)
const activeSelectedDebtQuote = computed(() =>
  isExternalSourceRoute.value ? selectedExternalDebtQuote.value : selectedDebtQuote.value,
)
const activeCollateralRouteItems = computed(() =>
  isExternalSourceRoute.value ? externalCollateralRouteItems.value : collateralRouteItems.value,
)
const activeDebtRouteItems = computed(() =>
  isExternalSourceRoute.value ? externalDebtRouteItems.value : debtRouteItems.value,
)
const activeCollateralSelectedProvider = computed(() =>
  isExternalSourceRoute.value ? externalCollateralSelectedProvider.value : collateralSelectedProvider.value,
)
const activeDebtSelectedProvider = computed(() =>
  isExternalSourceRoute.value ? externalDebtSelectedProvider.value : debtSelectedProvider.value,
)
const activeCollateralQuotesStatusLabel = computed(() =>
  isExternalSourceRoute.value ? externalCollateralQuotesStatusLabel.value : collateralQuotesStatusLabel.value,
)
const activeDebtQuotesStatusLabel = computed(() =>
  isExternalSourceRoute.value ? externalDebtQuotesStatusLabel.value : debtQuotesStatusLabel.value,
)
const isActiveCollateralQuoteLoading = computed(() =>
  isExternalSourceRoute.value ? isExternalCollateralQuoteLoading.value : isCollateralQuoteLoading.value,
)
const isActiveDebtQuoteLoading = computed(() =>
  isExternalSourceRoute.value ? isExternalDebtQuoteLoading.value : isDebtQuoteLoading.value,
)
const activeCollateralQuoteError = computed(() =>
  isExternalSourceRoute.value ? externalCollateralQuoteError.value : collateralQuoteError.value,
)
const activeDebtQuoteError = computed(() =>
  isExternalSourceRoute.value ? externalDebtQuoteError.value : debtQuoteError.value,
)
const selectActiveCollateralProvider = (provider: string) => {
  if (isExternalSourceRoute.value) {
    selectExternalCollateralProvider(provider)
    return
  }
  selectCollateralProvider(provider)
}
const selectActiveDebtProvider = (provider: string) => {
  if (isExternalSourceRoute.value) {
    selectExternalDebtProvider(provider)
    return
  }
  selectDebtProvider(provider)
}
const onRefreshActiveCollateralQuotes = () => {
  if (isExternalSourceRoute.value) {
    onRefreshExternalCollateralQuotes()
    return
  }
  onRefreshCollateralQuotes()
}
const onRefreshActiveDebtQuotes = () => {
  if (isExternalSourceRoute.value) {
    onRefreshExternalDebtQuotes()
    return
  }
  onRefreshDebtQuotes()
}

const fromSupplyApy = computed(() => {
  const vault = sourceCollateralVault.value
  if (!vault) return null
  const base = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(base, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
})

interface RefinanceBorrowApyValue {
  baseApy: number
  intrinsicApy: number
  totalApy: number
}

const getRefinanceBorrowApyValue = (
  vault: EVault,
  projected?: ProjectedRates | null,
): RefinanceBorrowApyValue => {
  const currentRaw = getVaultBorrowApy(vault)
  const projectedRaw = projected ? nanoToValue(projected.borrowAPY, 25) : null
  const baseApy = projectedRaw ?? currentRaw
  const totalApy = withProjectedVaultIntrinsicApy(
    currentRaw,
    projectedRaw,
    vault,
    enableIntrinsicApy.value,
  )
  return {
    baseApy,
    intrinsicApy: totalApy - baseApy,
    totalApy,
  }
}

const currentBorrowApyValue = computed(() =>
  projectionSourceDebtVault.value ? getRefinanceBorrowApyValue(projectionSourceDebtVault.value) : null,
)
const effectiveCurrentBorrowApyValue = computed(() =>
  projectionEffectiveDebtVault.value ? getRefinanceBorrowApyValue(projectionEffectiveDebtVault.value) : null,
)
const fromBorrowApy = computed(() => {
  void rewardsVersion.value
  const vault = projectionSourceDebtVault.value
  if (!vault) return null
  return computeBorrowApy(
    vault,
    viewer.value,
    {
      enableIntrinsicApy: enableIntrinsicApy.value,
      enableRewardsApy: enableRewardsApy.value,
    },
    effectiveCollateralAddressesForOptions.value,
  )
})
const toBorrowApy = computed(() => {
  return effectiveCurrentBorrowApyValue.value?.totalApy ?? null
})

const effectiveDebtProduct = useEulerProductOfVault(computed(() => effectiveDebtVault.value?.address || ''))
const effectiveCollateralProduct = useEulerProductOfVault(computed(() => effectiveCollateralVault.value?.address || ''))

type RefinanceCollateralVault = EVault | EulerEarn | SecuritizeCollateralVault

interface RefinanceCollateralLeg {
  vault: RefinanceCollateralVault
  amount: bigint
}

interface CollateralPortfolioEntry {
  address: string
  valueUsd: number
  baseSupplyApy: number
  intrinsicSupplyApy: number
  supplyRewardApy: number
  supplyCampaigns: ReturnType<typeof getSupplyRewardCampaigns>
}

interface CollateralPortfolioValue {
  valueUsd: number
  baseSupplyApy: number | null
  intrinsicSupplyApy: number | null
  supplyRewardApy: number | null
  entries: CollateralPortfolioEntry[]
}

interface NextRefinanceEstimate {
  supplyPortfolio: CollateralPortfolioValue
  borrowValueUsd: number
  borrowApy: RefinanceBorrowApyValue
  rateLines: ProjectedYieldRateLine[]
}

interface RefinanceRiskMetrics {
  ltv: number
  health: number
  liquidationLtv: number
  borrowLtv: number
}

const isRefinanceCollateralVault = (vault?: VaultEntity): vault is RefinanceCollateralVault =>
  !!vault && 'address' in vault && 'asset' in vault && 'shares' in vault

const nextCollateralAmountNano = computed<bigint | null>(() => {
  if (!effectiveCollateralVault.value) return null
  if (!hasCollateralChange.value) return currentCollateralAssets.value
  if (!targetCollateralVault.value) return null
  if (isSameCollateralAsset.value) return currentCollateralAssets.value
  if (!activeCollateralQuote.value) return null
  return BigInt(activeCollateralQuote.value.amountOut || 0)
})

const currentCollateralLegs = computed<RefinanceCollateralLeg[]>(() =>
  resolveRefinanceCollateralLegs(
    position.value?.collaterals ?? [],
    (address, fallback) => getLayeredVault(address, fallback ?? getVault(address)),
    isRefinanceCollateralVault,
  ),
)
const sourceCollateralVaultAddresses = computed(() => {
  const currentPosition = position.value
  if (!currentPosition) return []

  const addresses = new Set<string>()
  const addAddress = (address: string | undefined) => {
    const normalized = normalizeVaultAddress(address)
    if (normalized) addresses.add(normalized)
  }

  for (const address of currentPosition.collateralVaults ?? []) addAddress(address)
  addAddress(currentPosition.collateral?.vaultAddress)
  addAddress(currentPosition.collateralVault?.address)

  return Array.from(addresses)
})

const nextCollateralLegs = computed<RefinanceCollateralLeg[]>(() => {
  if (!hasCollateralChange.value) return currentCollateralLegs.value

  const target = projectionTargetCollateralVault.value
  const targetAmount = nextCollateralAmountNano.value
  const sourceAddress = normalizeVaultAddress(sourceCollateralVault.value?.address)
  const legs: RefinanceCollateralLeg[] = []
  let replacedSource = false

  for (const leg of currentCollateralLegs.value) {
    if (sourceAddress && normalizeVaultAddress(leg.vault.address) === sourceAddress) {
      replacedSource = true
      if (target && targetAmount !== null && targetAmount > 0n) {
        legs.push({ vault: target, amount: targetAmount })
      }
      continue
    }

    legs.push(leg)
  }

  if (!replacedSource && target && targetAmount !== null && targetAmount > 0n) {
    legs.push({ vault: target, amount: targetAmount })
  }

  return legs
})

const nextDebtAmountNano = computed<bigint | null>(() => {
  if (!effectiveDebtVault.value) return null
  if (!hasDebtChange.value) return currentDebt.value
  if (!targetDebtVault.value) return null
  if (isSameDebtAsset.value) {
    return getSameAssetRefinanceBorrowAmount(currentDebt.value, isExternalSourceRoute.value)
  }
  if (!activeDebtQuote.value) return null
  return getSwapInputAmount(activeDebtQuote.value, SwapperMode.TARGET_DEBT)
})

const areCurrentRoeLegsComplete = computed(() =>
  sourceCollateralVaultAddresses.value.every(address =>
    currentCollateralLegs.value.some(leg => normalizeVaultAddress(leg.vault.address) === address),
  ),
)
const isCurrentRoeApplicable = computed(() =>
  isRoeStateApplicable({
    vaults: currentCollateralLegs.value.map(({ vault }) => vault),
    isComplete: areCurrentRoeLegsComplete.value,
  }, projectionSourceDebtVault.value, getTokenCategoryTags),
)
const isNextRoeApplicable = computed(() =>
  isRoeStateApplicable({
    vaults: nextCollateralLegs.value.map(({ vault }) => vault),
    isComplete: areCurrentRoeLegsComplete.value,
  }, projectionEffectiveDebtVault.value, getTokenCategoryTags),
)

const getRefinanceRateAddress = (address: string) => address.toLowerCase()

const getSupplyApyValueForVault = (vault: RefinanceCollateralVault, projected?: ProjectedRates | null) => {
  const currentRaw = getVaultSupplyApy(vault)
  const projectedRaw = projected ? nanoToValue(projected.supplyAPY, 25) : null
  const baseSupplyApy = projectedRaw ?? currentRaw
  const supplyApyWithIntrinsic = withProjectedVaultIntrinsicApy(
    currentRaw,
    projectedRaw,
    vault,
    enableIntrinsicApy.value,
  )
  const supplyRewardApy = getSupplyRewardApy(vault.address)
  return {
    baseSupplyApy,
    intrinsicSupplyApy: supplyApyWithIntrinsic - baseSupplyApy,
    supplyRewardApy,
  }
}

const getCollateralPortfolioValue = async (
  legs: RefinanceCollateralLeg[],
  projectedByAddress: ReadonlyMap<string, ProjectedRates> = new Map(),
): Promise<CollateralPortfolioValue | null> => {
  if (!legs.length) return null

  let valueUsd = 0
  const entries: CollateralPortfolioEntry[] = []
  for (const leg of legs) {
    const legValue = await getAssetUsdValueForEstimate(leg.amount, leg.vault, 'off-chain')
    if (legValue === undefined || legValue === null) return null
    const apy = getSupplyApyValueForVault(
      leg.vault,
      projectedByAddress.get(getRefinanceRateAddress(leg.vault.address)),
    )
    valueUsd += legValue
    entries.push({
      address: leg.vault.address,
      valueUsd: legValue,
      ...apy,
      supplyCampaigns: getSupplyRewardCampaigns(leg.vault.address),
    })
  }

  const weighted = (select: (entry: CollateralPortfolioEntry) => number) =>
    valueUsd > 0
      ? entries.reduce((sum, entry) => sum + entry.valueUsd * select(entry), 0) / valueUsd
      : null

  return {
    valueUsd,
    baseSupplyApy: weighted(entry => entry.baseSupplyApy),
    intrinsicSupplyApy: weighted(entry => entry.intrinsicSupplyApy),
    supplyRewardApy: weighted(entry => entry.supplyRewardApy),
    entries,
  }
}

const getRefinanceProjectedRateLines = (
  beforeCollateralLegs: readonly RefinanceCollateralLeg[],
  afterCollateralLegs: readonly RefinanceCollateralLeg[],
  sourceDebt: EVault | undefined,
  targetDebt: EVault,
  projectedByAddress: ReadonlyMap<string, ProjectedRates>,
): ProjectedYieldRateLine[] => {
  const lines: ProjectedYieldRateLine[] = []
  const collateralVaults = new Map<string, RefinanceCollateralVault>()
  for (const leg of [...beforeCollateralLegs, ...afterCollateralLegs]) {
    collateralVaults.set(getRefinanceRateAddress(leg.vault.address), leg.vault)
  }

  for (const [address, vault] of collateralVaults) {
    const currentRaw = getVaultSupplyApy(vault)
    const projected = projectedByAddress.get(address)
    lines.push({
      id: `supply:${address}`,
      label: 'Collateral lending APY',
      symbol: vault.asset.symbol,
      vaultAddress: vault.address,
      before: currentRaw,
      after: projected ? nanoToValue(projected.supplyAPY, 25) : currentRaw,
    })
  }

  const sourceAddress = sourceDebt ? getRefinanceRateAddress(sourceDebt.address) : ''
  const targetAddress = getRefinanceRateAddress(targetDebt.address)
  if (sourceDebt && sourceAddress === targetAddress) {
    const currentRaw = getVaultBorrowApy(sourceDebt)
    const projected = projectedByAddress.get(sourceAddress)
    lines.push({
      id: `borrow:${sourceAddress}`,
      label: 'Liability borrow APY',
      symbol: sourceDebt.asset.symbol,
      vaultAddress: sourceDebt.address,
      before: currentRaw,
      after: projected ? nanoToValue(projected.borrowAPY, 25) : currentRaw,
    })
    return lines
  }

  if (sourceDebt) {
    const projected = projectedByAddress.get(sourceAddress)
    lines.push({
      id: `borrow:${sourceAddress}`,
      label: 'Current liability borrow APY',
      symbol: sourceDebt.asset.symbol,
      vaultAddress: sourceDebt.address,
      before: getVaultBorrowApy(sourceDebt),
      ...(projected ? { after: nanoToValue(projected.borrowAPY, 25) } : {}),
    })
  }

  const targetCurrentRaw = getVaultBorrowApy(targetDebt)
  const targetProjected = projectedByAddress.get(targetAddress)
  lines.push({
    id: `borrow:${targetAddress}`,
    label: sourceDebt ? 'New liability borrow APY' : 'Liability borrow APY',
    symbol: targetDebt.asset.symbol,
    vaultAddress: targetDebt.address,
    before: targetCurrentRaw,
    after: targetProjected ? nanoToValue(targetProjected.borrowAPY, 25) : targetCurrentRaw,
  })
  return lines
}

const nextCollateralRateDeltas = computed(() => {
  const deltas = new Map<string, { vault: EVault, cashDelta: bigint }>()
  const addDelta = (vault: VaultEntity | undefined, cashDelta: bigint) => {
    if (!vault || !isEVault(vault) || cashDelta === 0n) return
    const address = normalizeVaultAddress(vault.address)
    const existing = deltas.get(address)
    deltas.set(address, {
      vault,
      cashDelta: (existing?.cashDelta ?? 0n) + cashDelta,
    })
  }

  if (hasCollateralChange.value) {
    addDelta(projectionSourceCollateralVault.value, -currentCollateralAssets.value)
    addDelta(projectionTargetCollateralVault.value, nextCollateralAmountNano.value ?? 0n)
  }

  return [...deltas.values()].filter(delta => delta.cashDelta !== 0n)
})

const currentSupplyPortfolioValue = shallowRef<CollateralPortfolioValue | null>(null)
const currentSupplyPortfolioGuard = createRaceGuard()
watchEffect(async () => {
  void rewardsVersion.value
  void enableIntrinsicApy.value
  const gen = currentSupplyPortfolioGuard.next()
  currentSupplyPortfolioValue.value = null
  const legs = currentCollateralLegs.value
  const value = await getCollateralPortfolioValue(legs)
  if (!currentSupplyPortfolioGuard.isStale(gen)) currentSupplyPortfolioValue.value = value
})
const currentBorrowValueUsd = ref<number | null>(null)
const currentBorrowValueGuard = createRaceGuard()
watchEffect(async () => {
  const gen = currentBorrowValueGuard.next()
  currentBorrowValueUsd.value = null
  const vault = projectionSourceDebtVault.value
  const amount = currentDebt.value
  if (!vault) return
  const value = (await getAssetUsdValueForEstimate(amount, vault, 'off-chain')) ?? null
  if (!currentBorrowValueGuard.isStale(gen)) currentBorrowValueUsd.value = value
})
const nextRefinanceEstimate = shallowRef<NextRefinanceEstimate | null>(null)
const nextSupplyPortfolioValue = computed(() => nextRefinanceEstimate.value?.supplyPortfolio ?? null)
const nextBorrowValueUsd = computed(() => nextRefinanceEstimate.value?.borrowValueUsd ?? null)
const projectedNextBorrowApyValue = computed(() => nextRefinanceEstimate.value?.borrowApy ?? null)
const nextRefinanceEstimateGuard = createRaceGuard()
watchEffect(async () => {
  void rewardsVersion.value
  void enableIntrinsicApy.value
  const gen = nextRefinanceEstimateGuard.next()
  nextRefinanceEstimate.value = null
  const beforeLegs = currentCollateralLegs.value
  const legs = nextCollateralLegs.value
  const vault = projectionEffectiveDebtVault.value
  const amount = nextDebtAmountNano.value
  const baseApy = toBorrowApy.value
  const collateralRateDeltas = nextCollateralRateDeltas.value
  const sourceDebt = projectionSourceDebtVault.value
  const currentDebtAmount = currentDebt.value

  if (!vault || amount === null || baseApy === null) return

  const staysInSourceVault = normalizeVaultAddress(vault.address) === normalizeVaultAddress(sourceDebt?.address)
  const debtRateDeltas = [{
    vault,
    borrowsDelta: staysInSourceVault ? amount - currentDebtAmount : amount,
  }]
  const sourceDebtIsProjectedCollateral = !!sourceDebt && legs.some(leg =>
    leg.amount > 0n
    && normalizeVaultAddress(leg.vault.address) === normalizeVaultAddress(sourceDebt.address),
  )
  if (sourceDebt && !staysInSourceVault && sourceDebtIsProjectedCollateral && currentDebtAmount > 0n) {
    debtRateDeltas.push({ vault: sourceDebt, borrowsDelta: -currentDebtAmount })
  }
  const projectionEntries = buildRefinanceProjectedRateRequests(
    collateralRateDeltas,
    debtRateDeltas,
  )

  try {
    const [projectedRates, borrowValue] = await Promise.all([
      projectionEntries.length
        ? getProjectedRatesBatch(projectionEntries.map(projection => projection.request))
        : Promise.resolve([]),
      getAssetUsdValueForEstimate(amount, vault, 'off-chain'),
    ])
    if (nextRefinanceEstimateGuard.isStale(gen)) return

    if (!areProjectedRatesComplete(projectedRates, projectionEntries.length)) return

    const projectedByAddress = new Map(
      projectionEntries.map((projection, index) => [projection.address, projectedRates[index]]),
    )
    const portfolioValue = await getCollateralPortfolioValue(legs, projectedByAddress)
    if (nextRefinanceEstimateGuard.isStale(gen)) return
    if (!portfolioValue || borrowValue === undefined || borrowValue === null) return

    const projectedBorrow = projectedByAddress.get(getRefinanceRateAddress(vault.address))
    nextRefinanceEstimate.value = {
      supplyPortfolio: portfolioValue,
      borrowValueUsd: borrowValue,
      borrowApy: getRefinanceBorrowApyValue(vault, projectedBorrow),
      rateLines: getRefinanceProjectedRateLines(
        beforeLegs,
        legs,
        sourceDebt,
        vault,
        projectedByAddress,
      ),
    }
  }
  catch (error) {
    if (!nextRefinanceEstimateGuard.isStale(gen)) {
      logWarn('refinance/projectedEstimates', error)
    }
  }
})

const externalSupplyProjectedYieldDetails = shallowRef<ProjectedYieldDetails | null>(null)
const externalSupplyEstimateGuard = createRaceGuard()
watchEffect(async () => {
  void rewardsVersion.value
  void enableIntrinsicApy.value
  const gen = externalSupplyEstimateGuard.next()
  externalSupplyProjectedYieldDetails.value = null
  const target = projectionTargetCollateralVault.value
  const amount = nextCollateralAmountNano.value
  if (
    !externalIsSupplyOnly.value
    || !target
    || amount === null
    || amount <= 0n
    || !isEVault(target)
    || (collateralNeedsSwap.value && !activeSelectedCollateralQuote.value)
  ) return

  try {
    const projectedRates = await getProjectedRatesBatch([{
      vaultAddress: target.address,
      currentCash: target.totalCash,
      currentBorrows: target.totalBorrowed,
      cashDelta: amount,
      borrowsDelta: 0n,
    }])
    if (externalSupplyEstimateGuard.isStale(gen) || !areProjectedRatesComplete(projectedRates, 1)) return

    const currentRaw = getVaultSupplyApy(target)
    const projectedRaw = nanoToValue(projectedRates[0]!.supplyAPY, 25)
    const projectedWithIntrinsic = withProjectedVaultIntrinsicApy(
      currentRaw,
      projectedRaw,
      target,
      enableIntrinsicApy.value,
    )
    const after = getProjectedYieldState('supply-apy', {
      supplyUsd: 1,
      baseSupplyApy: projectedRaw,
      intrinsicSupplyApy: projectedWithIntrinsic - projectedRaw,
      supplyRewardApy: getSupplyRewardApy(target.address),
      borrowUsd: 0,
      baseBorrowApy: 0,
    })
    if (!after) return
    const campaigns = getSupplyRewardCampaigns(target.address)
      .map(campaign => ({ campaign, vaultAddress: target.address }))
    externalSupplyProjectedYieldDetails.value = {
      metric: 'supply-apy',
      after,
      rateLines: [{
        id: `supply:${target.address.toLowerCase()}`,
        label: 'Lending APY',
        symbol: target.asset.symbol,
        vaultAddress: target.address,
        before: currentRaw,
        after: projectedRaw,
      }],
      rewards: mergeProjectedRewardCampaigns([], campaigns),
    }
  }
  catch (error) {
    if (!externalSupplyEstimateGuard.isStale(gen)) logWarn('external-migration/projectedSupplyApy', error)
  }
})
const externalSupplyApyAfter = computed(() => externalSupplyProjectedYieldDetails.value?.after.total ?? null)

const currentCollateralAddresses = computed(() => currentCollateralLegs.value.map(leg => leg.vault.address))
const nextCollateralAddresses = computed(() => nextCollateralLegs.value.map(leg => leg.vault.address))
const currentBorrowRewardApy = computed(() => sourceDebtVault.value
  ? getBorrowRewardApyForCollaterals(sourceDebtVault.value.address, currentCollateralAddresses.value)
  : 0)
const nextBorrowRewardApy = computed(() => effectiveDebtVault.value
  ? getBorrowRewardApyForCollaterals(effectiveDebtVault.value.address, nextCollateralAddresses.value)
  : 0)
const currentPositionMultiplier = computed(() =>
  getPositionMultiplier(currentSupplyPortfolioValue.value?.valueUsd, currentBorrowValueUsd.value),
)
const nextPositionMultiplier = computed(() =>
  getPositionMultiplier(nextSupplyPortfolioValue.value?.valueUsd, nextBorrowValueUsd.value),
)
const currentLoopingRewardApy = computed(() => sourceDebtVault.value
  ? getEligibleLoopingRewardApyForCollaterals(
      sourceDebtVault.value.address,
      currentCollateralAddresses.value,
      currentPositionMultiplier.value,
    )
  : 0)
const nextLoopingRewardApy = computed(() => effectiveDebtVault.value
  ? getEligibleLoopingRewardApyForCollaterals(
      effectiveDebtVault.value.address,
      nextCollateralAddresses.value,
      nextPositionMultiplier.value,
    )
  : 0)

const getRefinanceRoeState = (
  supplyPortfolio: CollateralPortfolioValue | null,
  borrowValueUsd: number | null,
  borrowApy: RefinanceBorrowApyValue | null,
  borrowRewardApy: number,
  loopingRewardApy: number,
): ProjectedYieldState | null => {
  if (
    !supplyPortfolio
    || borrowValueUsd === null
    || !borrowApy
    || supplyPortfolio.baseSupplyApy === null
    || supplyPortfolio.intrinsicSupplyApy === null
    || supplyPortfolio.supplyRewardApy === null
  ) return null

  return getProjectedYieldState('roe', {
    supplyUsd: supplyPortfolio.valueUsd,
    baseSupplyApy: supplyPortfolio.baseSupplyApy,
    intrinsicSupplyApy: supplyPortfolio.intrinsicSupplyApy,
    supplyRewardApy: supplyPortfolio.supplyRewardApy,
    borrowUsd: borrowValueUsd,
    baseBorrowApy: borrowApy.baseApy,
    intrinsicBorrowApy: borrowApy.intrinsicApy,
    borrowRewardApy,
    loopingRewardApy,
  })
}

const currentRoeState = computed(() => {
  if (!isCurrentRoeApplicable.value) return null
  return getRefinanceRoeState(
    currentSupplyPortfolioValue.value,
    currentBorrowValueUsd.value,
    currentBorrowApyValue.value,
    currentBorrowRewardApy.value,
    currentLoopingRewardApy.value,
  )
})
const nextRoeState = computed(() => {
  if (!isNextRoeApplicable.value) return null
  return getRefinanceRoeState(
    nextSupplyPortfolioValue.value,
    nextBorrowValueUsd.value,
    projectedNextBorrowApyValue.value,
    nextBorrowRewardApy.value,
    nextLoopingRewardApy.value,
  )
})
const roeBefore = computed(() => currentRoeState.value?.total ?? null)
const roeAfter = computed(() => nextRoeState.value?.total ?? null)

const getRefinanceRewardCampaignInputs = (
  supplyPortfolio: CollateralPortfolioValue,
  borrowVault: EVault,
  collateralAddresses: readonly string[],
  multiplier: number | null,
): ProjectedYieldCampaignInput[] => [
  ...supplyPortfolio.entries
    .filter(entry => entry.valueUsd > 0)
    .flatMap(entry => entry.supplyCampaigns.map(campaign => ({
      campaign,
      vaultAddress: entry.address,
    }))),
  ...getBorrowRewardCampaignsForCollaterals(borrowVault.address, collateralAddresses)
    .map(campaign => ({ campaign, vaultAddress: borrowVault.address })),
  ...getEligibleLoopingRewardCampaignsForCollaterals(
    borrowVault.address,
    collateralAddresses,
    multiplier,
  ).map(campaign => ({ campaign, vaultAddress: borrowVault.address })),
]

const currentLtv = computed(() => {
  const ltv = position.value?.userLTV ?? position.value?.currentLTV
  return ltv === undefined ? null : ltvToPercent(nanoToValue(ltv, 18))
})
const currentHealth = computed(() => {
  const health = position.value?.healthFactor
  return health === undefined ? null : nanoToValue(health, 18)
})
const currentPriceRatio = computed(() => {
  if (!sourceCollateralVault.value || !sourceDebtVault.value) return null
  const collateralPrice = getCollateralOraclePrice(sourceDebtVault.value, sourceCollateralVault.value)
  const borrowPrice = getAssetOraclePrice(sourceDebtVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const nextPriceRatio = computed(() => {
  if (!effectiveCollateralVault.value || !effectiveDebtVault.value) return null
  const collateralPrice = getCollateralOraclePrice(effectiveDebtVault.value, effectiveCollateralVault.value)
  const borrowPrice = getAssetOraclePrice(effectiveDebtVault.value)
  return conservativePriceRatioNumber(collateralPrice, borrowPrice)
})
const nextDebtAmount = computed(() => {
  if (!effectiveDebtVault.value || nextDebtAmountNano.value === null) return null
  return nanoToValue(nextDebtAmountNano.value, effectiveDebtVault.value.shares.decimals)
})
const getRiskMetrics = (
  debtVault: EVault | undefined,
  collateralLegs: RefinanceCollateralLeg[],
  debtAmount: number | null,
): RefinanceRiskMetrics | null => {
  if (!debtVault || debtAmount === null) return null
  if (debtAmount <= 0) {
    return {
      ltv: 0,
      health: Infinity,
      liquidationLtv: Infinity,
      borrowLtv: Infinity,
    }
  }

  let totalCollateralValue = 0
  let borrowCapacity = 0
  let liquidationCapacity = 0
  for (const leg of collateralLegs) {
    if (leg.amount <= 0n) continue
    const match = debtVault.collaterals.find(
      ltv => normalizeVaultAddress(ltv.address) === normalizeVaultAddress(leg.vault.address),
    )
    if (!match) continue

    const priceRatio = conservativePriceRatioNumber(
      getCollateralOraclePrice(debtVault, leg.vault),
      getAssetOraclePrice(debtVault),
    )
    if (priceRatio === null || priceRatio <= 0) return null

    const amount = nanoToValue(leg.amount, leg.vault.shares.decimals)
    const collateralValue = amount * priceRatio
    if (!Number.isFinite(collateralValue) || collateralValue <= 0) continue

    totalCollateralValue += collateralValue
    borrowCapacity += collateralValue * ltvToPercent(match.borrowLTV)
    liquidationCapacity += collateralValue * ltvToPercent(match.liquidationLTV)
  }

  if (totalCollateralValue <= 0) return null

  const ltv = (debtAmount / totalCollateralValue) * 100
  const liquidationLtv = liquidationCapacity / totalCollateralValue
  const borrowLtv = borrowCapacity / totalCollateralValue

  return {
    ltv,
    health: ltv > 0 ? liquidationLtv / ltv : Infinity,
    liquidationLtv,
    borrowLtv,
  }
}
const currentRiskMetrics = computed<RefinanceRiskMetrics | null>(() =>
  getRiskMetrics(sourceDebtVault.value, currentCollateralLegs.value, nanoToValue(currentDebt.value, sourceDebtVault.value?.shares.decimals ?? 18)),
)
const nextRiskMetrics = computed<RefinanceRiskMetrics | null>(() =>
  getRiskMetrics(effectiveDebtVault.value, nextCollateralLegs.value, nextDebtAmount.value),
)
const nextLtv = computed(() => nextRiskMetrics.value?.ltv ?? null)
const currentBorrowLtv = computed(() => currentRiskMetrics.value?.borrowLtv ?? null)
const nextBorrowLtv = computed(() => nextRiskMetrics.value?.borrowLtv ?? null)
const nextHealth = computed(() => nextRiskMetrics.value?.health ?? null)
const currentLiquidationPrice = computed(() => {
  if (!currentPriceRatio.value || !currentHealth.value) return null
  if (currentHealth.value < 1) return null
  return currentPriceRatio.value / currentHealth.value
})
const nextLiquidationPrice = computed(() => {
  if (!nextPriceRatio.value || !nextHealth.value) return null
  if (nextHealth.value < 1) return null
  return nextPriceRatio.value / nextHealth.value
})

const liqPriceInvert = usePriceInvert(
  () => effectiveCollateralVault.value?.asset.symbol,
  () => effectiveDebtVault.value?.asset.symbol,
)
const currentLiqDisplaySymbol = computed(() => {
  const collateral = sourceCollateralVault.value?.asset.symbol || ''
  const debt = sourceDebtVault.value?.asset.symbol || ''
  return liqPriceInvert.isInverted ? `${debt}/${collateral}` : `${collateral}/${debt}`
})

const pairCompatibilityError = computed(() => {
  if (externalIsSupplyOnly.value) return null
  if (!hasAnyChange.value || !effectiveDebtVault.value || !effectiveCollateralVault.value) return null
  return isDebtCollateralCompatible(effectiveDebtVault.value, effectiveCollateralVault.value)
    ? null
    : 'Selected debt vault does not accept the selected collateral'
})
const collateralCowDebtSwapError = computed(() =>
  isSelectedCollateralCowSwapProvider.value && hasDebtChange.value
    ? 'CoW can only be used to swap collateral. Choose a non-CoW route or remove the debt vault change.'
    : null,
)
const hasAllRequiredQuotes = computed(() =>
  (!collateralNeedsSwap.value || !!activeSelectedCollateralQuote.value)
  && (!debtNeedsSwap.value || !!activeSelectedDebtQuote.value),
)
const showNextRefinanceMetrics = computed(() => hasAnyChange.value && hasAllRequiredQuotes.value)
const refinanceProjectedYieldDetails = computed<ProjectedYieldDetails | null>(() => {
  void rewardsVersion.value
  const before = currentRoeState.value
  const after = nextRoeState.value
  const estimate = nextRefinanceEstimate.value
  const currentPortfolio = currentSupplyPortfolioValue.value
  const sourceDebt = sourceDebtVault.value
  const targetDebt = effectiveDebtVault.value
  if (
    !showNextRefinanceMetrics.value
    || roeAfter.value === null
    || !after
    || !estimate
    || !targetDebt
  ) return null

  const beforeCampaigns = before && currentPortfolio && sourceDebt
    ? getRefinanceRewardCampaignInputs(
        currentPortfolio,
        sourceDebt,
        currentCollateralAddresses.value,
        currentPositionMultiplier.value,
      )
    : []
  const afterCampaigns = getRefinanceRewardCampaignInputs(
    estimate.supplyPortfolio,
    targetDebt,
    nextCollateralAddresses.value,
    nextPositionMultiplier.value,
  )

  return {
    metric: 'roe',
    before,
    after,
    rateLines: estimate.rateLines,
    rewards: mergeProjectedRewardCampaigns(beforeCampaigns, afterCampaigns),
  }
})
const healthError = computed(() => {
  if (isExternalSourceRoute.value) return null
  if (!hasAnyChange.value || !hasAllRequiredQuotes.value || nextHealth.value === null) return null
  if (!Number.isFinite(nextHealth.value)) return null
  return nextHealth.value <= 1 ? 'Refinance would make position unhealthy' : null
})
const borrowCapacityError = computed(() => {
  if (externalIsSupplyOnly.value) return null
  if (!hasAnyChange.value || !hasAllRequiredQuotes.value) return null
  if (!effectiveDebtVault.value) return null
  if (!nextBorrowLtv.value || nextBorrowLtv.value <= 0) {
    return 'Selected debt vault does not accept the selected collateral'
  }
  return null
})
const refinanceGuardError = computed(() => collateralCowDebtSwapError.value || pairCompatibilityError.value)

watch(refinanceGuardError, (error) => {
  if (error) {
    registerOperationBlocker('refinance-validation', error)
  }
  else {
    unregisterOperationBlocker('refinance-validation')
  }
}, { immediate: true })

onUnmounted(() => {
  unregisterOperationBlocker('refinance-validation')
})

const plannedOps = computed<PlannedOp[]>(() => {
  const steps: PlannedOp[] = []
  if (isExternalSourceRoute.value) {
    // Hook-based op gating only applies to EVaults; EulerEarn deposit limits
    // are enforced on-chain and surface through the plan simulation.
    if (targetCollateralEVault.value) {
      steps.push({ vault: targetCollateralEVault.value, op: OP_DEPOSIT })
    }
    if (targetDebtVault.value) {
      steps.push({ vault: targetDebtVault.value, op: OP_BORROW })
    }
    return steps
  }
  if (hasCollateralChange.value && sourceCollateralEVault.value && targetCollateralEVault.value) {
    steps.push({
      vault: sourceCollateralEVault.value,
      op: isSameCollateralAsset.value ? OP_REDEEM : OP_WITHDRAW,
    })
    steps.push({ vault: targetCollateralEVault.value, op: OP_SKIM })
  }
  if (hasDebtChange.value && sourceDebtVault.value && targetDebtVault.value) {
    steps.push({ vault: targetDebtVault.value, op: OP_BORROW })
    if (isSameDebtAsset.value) {
      steps.push({ vault: sourceDebtVault.value, op: OP_SKIM })
      steps.push({ vault: sourceDebtVault.value, op: OP_REPAY_WITH_SHARES })
    }
    else {
      steps.push({ vault: sourceDebtVault.value, op: OP_REPAY })
    }
  }
  return steps
})
const hookWarning = computed(() => getPlanHookDisabledWarning(plannedOps.value))

const debtLiquidityError = computed(() => {
  const vault = targetDebtVault.value
  const amount = nextDebtAmountNano.value
  if (!hasDebtChange.value || !vault || amount === null) return null
  if (vault.availableLiquidity < amount) return 'Not enough liquidity in the target debt vault'
  if (vault.caps.borrowCap > 0n && vault.caps.borrowCap < maxUint256 && vault.totalBorrowed + amount > vault.caps.borrowCap) {
    return 'Borrow cap would be exceeded on the target debt vault'
  }
  return null
})
const collateralSupplyCapError = computed(() => {
  const vault = targetCollateralVault.value
  const amount = nextCollateralAmountNano.value
  if (!hasCollateralChange.value || !vault || amount === null) return null
  // EulerEarn vaults have no EVault-style caps; their deposit limits are
  // enforced on-chain and surface through the plan simulation.
  if (!isEVault(vault)) return null
  if (vault.caps.supplyCap > 0n && vault.caps.supplyCap < maxUint256 && vault.totalAssets + amount > vault.caps.supplyCap) {
    return 'Supply cap would be exceeded on the target collateral vault'
  }
  return null
})

const collateralPriceImpact = ref<number | null>(null)
watchEffect(async () => {
  if (!collateralNeedsSwap.value || !collateralQuote.value || !sourceCollateralEVault.value || !targetCollateralVault.value) {
    collateralPriceImpact.value = null
    return
  }
  const amountInUsd = await getAssetUsdValue(BigInt(collateralQuote.value.amountIn || 0), sourceCollateralEVault.value, 'off-chain')
  const amountOutUsd = await getAssetUsdValue(BigInt(collateralQuote.value.amountOut || 0), targetCollateralVault.value, 'off-chain')
  if (!amountInUsd || !amountOutUsd) {
    collateralPriceImpact.value = null
    return
  }
  const impact = (amountOutUsd / amountInUsd - 1) * 100
  collateralPriceImpact.value = Number.isFinite(impact) ? impact : null
})
const debtPriceImpact = ref<number | null>(null)
watchEffect(async () => {
  if (!debtNeedsSwap.value || !debtQuote.value || !sourceDebtVault.value || !targetDebtVault.value) {
    debtPriceImpact.value = null
    return
  }
  const oldDebtUsd = await getAssetUsdValue(BigInt(debtQuote.value.amountOut || 0), sourceDebtVault.value, 'off-chain')
  const newDebtUsd = await getAssetUsdValue(BigInt(debtQuote.value.amountIn || 0), targetDebtVault.value, 'off-chain')
  if (!oldDebtUsd || !newDebtUsd) {
    debtPriceImpact.value = null
    return
  }
  const impact = (oldDebtUsd / newDebtUsd - 1) * 100
  debtPriceImpact.value = Number.isFinite(impact) ? impact : null
})
const directPriceImpact = computed(() => {
  const impacts = [collateralPriceImpact.value, debtPriceImpact.value]
    .filter((value): value is number => value !== null)
  if (!impacts.length) return null
  return Math.min(...impacts)
})
const shouldGateUnknownPriceImpact = computed(() =>
  !isExternalSourceRoute.value
  && (
    (collateralNeedsSwap.value && !!activeSelectedCollateralQuote.value && collateralPriceImpact.value === null)
    || (debtNeedsSwap.value && !!activeSelectedDebtQuote.value && debtPriceImpact.value === null)
  ),
)
const { guardWithPriceImpact } = usePriceImpactGate({
  directPriceImpact,
  shouldGateUnknown: shouldGateUnknownPriceImpact,
})

const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(...getOperationVaultAddresses()))
const isBatchActive = computed(() => batchEntryCount.value > 0)
const directInboundMigrationDisabledReason = computed(() =>
  isExternalSourceRoute.value && isBatchActive.value ? BATCH_ACTIVE_REASON : null,
)
const validationError = computed(() => {
  if (isExternalSourceRoute.value) {
    return directInboundMigrationDisabledReason.value || inboundMigrationDisabledReason.value
  }
  if (!hasAnyChange.value) return 'Select a new collateral vault, debt vault, or both'
  if (collateralMigrationDisabledReason.value && targetCollateralVault.value) return collateralMigrationDisabledReason.value
  if (hookWarning.value) return hookWarning.value.message
  if (collateralCowDebtSwapError.value) return collateralCowDebtSwapError.value
  if (debtLiquidityError.value) return debtLiquidityError.value
  if (collateralSupplyCapError.value) return collateralSupplyCapError.value
  if (pairCompatibilityError.value) return pairCompatibilityError.value
  if (borrowCapacityError.value) return borrowCapacityError.value
  if (healthError.value) return healthError.value
  return null
})
// Batch execution validates the final merged account state, so adding a
// refinance entry does not require intermediate health/LTV/liquidity/cap checks
// to pass. Later batch entries can change the final account or market state.
const batchValidationError = computed(() => {
  if (!hasAnyChange.value) return 'Choose a new collateral vault, debt vault, or both'
  if (collateralMigrationDisabledReason.value && targetCollateralVault.value) return collateralMigrationDisabledReason.value
  if (hookWarning.value) return hookWarning.value.message
  if (collateralCowDebtSwapError.value) return collateralCowDebtSwapError.value
  if (pairCompatibilityError.value) return pairCompatibilityError.value
  return null
})
const isCowSwapSelectedForBatch = computed(() =>
  isCowProviderOrQuote(activeCollateralSelectedProvider.value, activeSelectedCollateralQuote.value)
  || isCowProviderOrQuote(activeDebtSelectedProvider.value, activeSelectedDebtQuote.value),
)
const canAddToBatch = computed(() => {
  if (isGeoBlocked.value || isLoading.value || isSubmitting.value || isPreparing.value) return false
  if (isExternalSourceRoute.value) {
    if (inboundMigrationDisabledReason.value) return false
    if (isCowSwapSelectedForBatch.value) return false
    return true
  }
  if (!position.value || !sourceDebtVault.value || !sourceCollateralVault.value) return false
  if (batchValidationError.value) return false
  if (!hasAllRequiredQuotes.value) return false
  if (isCowSwapSelectedForBatch.value) return false
  return true
})
const isSubmitDisabled = computed(() => {
  if (!isConnected.value) return false
  if (isLoading.value || isExternalPositionsLoading.value || isSubmitting.value) return true
  if (validationError.value) return true
  if (!hasAllRequiredQuotes.value) return true
  return !!simulationError.value
})
const isReviewButtonDisabled = computed(() => isSubmitDisabled.value || isPreparing.value)
const reviewRefinanceDisabled = computed(() => isGeoBlocked.value || isReviewButtonDisabled.value)
const reviewRefinanceLabel = computed(() => {
  if (isExternalSourceRoute.value) {
    if (!targetCollateralVault.value || (externalDebtAsset.value && !targetDebtVault.value)) return 'Select Vaults'
    if (!hasAllRequiredQuotes.value) return 'Select Quotes'
    return 'Review Migration'
  }
  if (!hasAnyChange.value) return 'Select Vaults'
  if (!hasAllRequiredQuotes.value) return 'Select Quotes'
  return 'Review Refinance'
})
const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (validationError.value) return { message: validationError.value, variant: validationError.value === healthError.value ? 'error' : 'warning' }
  if (activeCollateralQuoteError.value && collateralNeedsSwap.value) return { message: activeCollateralQuoteError.value, variant: 'warning' }
  if (activeDebtQuoteError.value && debtNeedsSwap.value) return { message: activeDebtQuoteError.value, variant: 'warning' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  if (collateralNeedsSwap.value && isActiveCollateralQuoteLoading.value) return { message: 'Fetching collateral swap quotes...', variant: 'warning' }
  if (debtNeedsSwap.value && isActiveDebtQuoteLoading.value) return { message: 'Fetching debt swap quotes...', variant: 'warning' }
  if (collateralNeedsSwap.value && !activeSelectedCollateralQuote.value) return { message: 'Select a collateral swap quote to continue', variant: 'warning' }
  if (debtNeedsSwap.value && !activeSelectedDebtQuote.value) return { message: 'Select a debt swap quote to continue', variant: 'warning' }
  return undefined
})

const debtDisplayAmount = computed({
  get: () => debtNeedsSwap.value && !activeDebtQuote.value
    ? ''
    : formatVaultAmount(nextDebtAmountNano.value ?? currentDebt.value, effectiveDebtVault.value),
  set: () => {},
})
const collateralDisplayAmount = computed({
  get: () => collateralNeedsSwap.value && !activeCollateralQuote.value
    ? ''
    : formatVaultAmount(nextCollateralAmountNano.value ?? currentCollateralAssets.value, effectiveCollateralVault.value),
  set: () => {},
})
const externalCollateralDisplayAmount = computed({
  get: () => {
    if (!targetCollateralVault.value) return ''
    if (collateralNeedsSwap.value && !activeCollateralQuote.value) return '0'
    return collateralDisplayAmount.value
  },
  set: () => {},
})
const externalDebtDisplayAmount = computed({
  get: () => {
    if (!targetDebtVault.value) return ''
    if (debtNeedsSwap.value && !activeDebtQuote.value) return '0'
    return debtDisplayAmount.value
  },
  set: () => {},
})

const collateralSwapSummary = computed(() =>
  activeCollateralQuote.value && targetCollateralVault.value
    ? isExternalSourceRoute.value && externalCollateralAsset.value
      ? buildAssetQuoteSummary(activeCollateralQuote.value, externalCollateralAsset.value, targetCollateralVault.value.asset, 'amountIn', 'amountOut')
      : sourceCollateralEVault.value
        ? buildQuoteSummary(activeCollateralQuote.value, sourceCollateralEVault.value, targetCollateralVault.value, 'amountIn', 'amountOut')
        : null
    : null,
)
const debtSwapSummary = computed(() =>
  activeDebtQuote.value && targetDebtVault.value
    ? isExternalSourceRoute.value && externalDebtAsset.value
      ? buildAssetQuoteSummary(activeDebtQuote.value, targetDebtVault.value.asset, externalDebtAsset.value, 'amountIn', 'amountOut')
      : sourceDebtVault.value
        ? buildQuoteSummary(activeDebtQuote.value, targetDebtVault.value, sourceDebtVault.value, 'amountIn', 'amountOut')
        : null
    : null,
)
const refinanceSwapReviewInfo = computed(() => {
  if (!collateralNeedsSwap.value || debtNeedsSwap.value || !activeCollateralQuote.value || !sourceCollateralEVault.value || !targetCollateralVault.value) return {}
  return {
    swapFromAsset: sourceCollateralEVault.value.asset,
    swapFromAmount: trimTrailingZeros(formatUnits(BigInt(activeCollateralQuote.value.amountIn || 0), Number(sourceCollateralEVault.value.asset.decimals))),
    swapToAsset: targetCollateralVault.value.asset,
    swapToAmount: trimTrailingZeros(formatUnits(BigInt(activeCollateralQuote.value.amountOut || 0), Number(targetCollateralVault.value.asset.decimals))),
    swapMode: SwapperMode.EXACT_IN,
  }
})
const refinanceVaultAmounts = computed(() => {
  if (!sourceCollateralVault.value) return undefined
  return {
    [sourceCollateralVault.value.address.toLowerCase()]: formatVaultAmount(currentCollateralAssets.value, sourceCollateralVault.value),
  }
})
const externalMigrationKnownAssets = computed(() => {
  const assets: Array<{ symbol: string, address: string, decimals: number | bigint }> = []
  const addAsset = (asset: { symbol: string, address: string, decimals: number | bigint } | null | undefined) => {
    if (asset) assets.push({ symbol: asset.symbol, address: asset.address, decimals: asset.decimals })
  }
  addAsset(externalCollateralAsset.value)
  addAsset(externalDebtAsset.value)
  addAsset(targetCollateralVault.value?.asset)
  addAsset(targetDebtVault.value?.asset)
  return assets
})
const externalMigrationSwapQuoteOutputs = computed(() => {
  const outputs: Array<{ tokenIn: string, tokenOut: string, amountOut: string }> = []
  const addQuote = (quote: SwapQuote | null | undefined) => {
    if (!quote) return
    outputs.push({
      tokenIn: quote.tokenIn.address,
      tokenOut: quote.tokenOut.address,
      amountOut: trimTrailingZeros(formatUnits(getQuoteAmount(quote, 'amountOut'), Number(quote.tokenOut.decimals))),
    })
  }
  addQuote(selectedExternalDebtQuote.value)
  addQuote(selectedExternalCollateralQuote.value)
  return outputs
})
const collateralRoutedVia = computed(() => getRoutedVia(activeCollateralSelectedProvider.value, activeCollateralQuote.value))
const debtRoutedVia = computed(() => getRoutedVia(activeDebtSelectedProvider.value, activeDebtQuote.value))
const effectiveQuoteFetchedAt = computed(() => {
  const fetched = [
    collateralNeedsSwap.value ? (isExternalSourceRoute.value ? externalCollateralQuoteFetchedAt.value : collateralQuoteFetchedAt.value) : null,
    debtNeedsSwap.value ? (isExternalSourceRoute.value ? externalDebtQuoteFetchedAt.value : debtQuoteFetchedAt.value) : null,
  ].filter((value): value is number => typeof value === 'number')
  return fetched.length ? Math.min(...fetched) : null
})

const inboundMigrationDisabledReason = computed(() => {
  if (!isExternalSourceRoute.value) return null
  if (!hasConnectedWallet.value) return 'Connect wallet to migrate'
  if (isExternalPositionsLoading.value) return 'Loading external position'
  if (externalPositionsError.value && !externalPosition.value) return externalPositionsError.value
  if (!externalPosition.value) return 'External position not found'
  if (!inboundExternalOwnerMatchesSource.value) return 'Active account does not match this migration source'
  if (externalPosition.value.disabledReason) return externalPosition.value.disabledReason
  if (!targetCollateralVault.value) return externalIsSupplyOnly.value ? 'Select a lend vault' : 'Select a collateral vault'
  if (externalDebtAsset.value && !targetDebtVault.value) return 'Select a debt vault'
  if (hookWarning.value) return hookWarning.value.message
  if (debtLiquidityError.value) return debtLiquidityError.value
  if (collateralSupplyCapError.value) return collateralSupplyCapError.value
  if (pairCompatibilityError.value) return pairCompatibilityError.value
  if (borrowCapacityError.value) return borrowCapacityError.value
  if (collateralNeedsSwap.value && isExternalCollateralQuoteLoading.value) return 'Fetching collateral swap quotes...'
  if (debtNeedsSwap.value && isExternalDebtQuoteLoading.value) return 'Fetching debt swap quotes...'
  if (collateralNeedsSwap.value && !selectedExternalCollateralQuote.value) return 'Select a collateral swap quote to continue'
  if (debtNeedsSwap.value && !selectedExternalDebtQuote.value) return 'Select a debt swap quote to continue'
  if (collateralNeedsSwap.value && selectedExternalCollateralQuote.value && getQuoteAmount(selectedExternalCollateralQuote.value, 'amountOut') <= 0n) {
    return 'Selected collateral swap route has no output'
  }
  if (debtNeedsSwap.value && selectedExternalDebtQuote.value && getQuoteAmount(selectedExternalDebtQuote.value, 'amountOut') <= 0n) {
    return 'Selected debt swap route has no output'
  }
  if (debtNeedsSwap.value && selectedExternalDebtQuote.value && getQuoteAmount(selectedExternalDebtQuote.value, 'amountOutMin') < currentDebt.value) {
    return 'Selected debt swap route does not cover the external debt'
  }
  if (isGeoBlocked.value) return 'This operation is not available in your region'
  if (simulationError.value) return simulationError.value
  return null
})
const canReviewInboundExternalMigration = computed(() =>
  isExternalSourceRoute.value
  && !inboundMigrationDisabledReason.value
  && !isPreparing.value
  && !isSubmitting.value,
)

type InboundExternalMigrationInput = {
  source: ExternalMigrationCandidate
  owner: Address
  position: MigrationPosition
  eulerTarget: EulerMigrationTarget
  collateralSwapQuote?: SwapQuote
  debtSwapQuote?: SwapQuote
}

type PreparedMigrationTenderlySimulation = {
  plan: TransactionPlan
  prepared: TransactionPlanPrepared
  stateOverrides: StateOverride
}

type InboundExternalMigrationPreview = {
  key: string
  useSignatures: boolean
  /**
   * The review showed the authorization riding in ONE atomic Safe proposal.
   * Latched at review time and revalidated at confirmation — execution must
   * never silently run a reviewed execution the user did not review.
   */
  bundledReview: boolean
  input: InboundExternalMigrationInput
  account: Account<IHasVaultAddress>
  tenderlySimulation: PreparedMigrationTenderlySimulation
  calldataPrepared: TransactionPlanPrepared
  authorizationRequest?: MigrationAuthorizationRequest
  prefetch?: PluginPrefetchData
  compilerResult: PlanMigrationSimulationResult
  observedBlock?: bigint
}

let inboundExternalMigrationPreviewRequestId = 0
let inboundExternalMigrationPreviewPromise: Promise<InboundExternalMigrationPreview> | null = null
let inboundExternalMigrationPreviewPromiseKey = ''
const STALE_INBOUND_EXTERNAL_MIGRATION_PREVIEW_ERROR = 'Migration inputs changed while preparing preview'

const swapQuotePreviewKey = (quote: SwapQuote | null | undefined): string => {
  if (!quote) return 'none'
  return [
    quote.tokenIn.address,
    quote.tokenOut.address,
    quote.accountIn,
    quote.accountOut,
    quote.vaultIn,
    quote.receiver,
    quote.amountIn,
    quote.amountInMax,
    quote.amountOut,
    quote.amountOutMin,
    quote.slippage,
    selectedQuoteProviderKey(quote),
  ].join(':')
}

const selectedQuoteProviderKey = (quote: SwapQuote): string => {
  const data = quote.providerData as { provider?: string, name?: string } | undefined
  return data?.provider || data?.name || ''
}

const inboundExternalMigrationPreviewKey = computed(() => {
  const source = externalPosition.value
  const owner = inboundExternalOwner.value
  const targetCollateral = targetCollateralVault.value
  if (!isExternalSourceRoute.value || !source || !owner || !targetCollateral || !chainId.value) return ''
  if (source.debt && !targetDebtVault.value) return ''
  if (!isSameCollateralAsset.value && !selectedExternalCollateralQuote.value) return ''
  if (source.debt && !isSameDebtAsset.value && !selectedExternalDebtQuote.value) return ''

  return [
    chainId.value,
    normalizeVaultAddress(owner),
    externalPositionKey.value,
    source.connectorId,
    source.id,
    targetCollateral.address,
    targetDebtVault.value?.address ?? 'no-debt',
    externalCollateralAmount.value.toString(),
    externalDebtAmount.value.toString(),
    String(slippage.value),
    externalCollateralSelectedProvider.value ?? '',
    externalDebtSelectedProvider.value ?? '',
    swapQuotePreviewKey(selectedExternalCollateralQuote.value),
    swapQuotePreviewKey(selectedExternalDebtQuote.value),
    // Signature mode changes the built plan and the displayed steps.
    signaturesEnabled.value ? 'sig' : 'nosig',
  ].join('|')
})

const buildInboundExternalMigrationInput = async (): Promise<InboundExternalMigrationInput> => {
  const source = externalPosition.value
  if (!chainId.value || !inboundExternalOwner.value || !source || !targetCollateralVault.value) {
    throw new Error('Migration inputs are incomplete')
  }
  if (!inboundExternalOwnerMatchesSource.value) {
    throw new Error('Active account does not match this migration source')
  }
  if (source.debt && !targetDebtVault.value) throw new Error('Migration inputs are incomplete')
  const collateralSwapQuote = isSameCollateralAsset.value ? undefined : selectedExternalCollateralQuote.value ?? undefined
  const debtSwapQuote = !source.debt || isSameDebtAsset.value ? undefined : selectedExternalDebtQuote.value ?? undefined
  if (!isSameCollateralAsset.value && !collateralSwapQuote) throw new Error('No collateral swap quote selected')
  if (source.debt && !isSameDebtAsset.value && !debtSwapQuote) throw new Error('No debt swap quote selected')

  const owner = getAddress(inboundExternalOwner.value) as Address
  const eulerAccount = await resolveInboundExternalEulerAccount()
  const position = await getMigrationPosition({
    connectorId: source.connectorId,
    chainId: source.chainId,
    owner,
    positionRef: source.ref,
  })
  const eulerTarget: EulerMigrationTarget = {
    eulerAccount,
    collateralVault: targetCollateralVault.value.address as Address,
  }
  if (collateralSwapQuote && isEulerEarn(targetCollateralVault.value)) {
    // EulerEarn has no `skim` — credit the swapped collateral through the
    // SwapVerifier's deposit-verified path instead.
    eulerTarget.collateralSwapVerification = 'deposit'
  }
  if (source.debt && targetDebtVault.value) {
    eulerTarget.borrowVault = targetDebtVault.value.address as Address
    eulerTarget.borrowAmount = debtSwapQuote
      ? getSwapInputAmount(debtSwapQuote, SwapperMode.TARGET_DEBT)
      : inboundBorrowAmountWithBuffer.value
  }
  const input: InboundExternalMigrationInput = { source, owner, position, eulerTarget }
  if (collateralSwapQuote) input.collateralSwapQuote = collateralSwapQuote
  if (debtSwapQuote) input.debtSwapQuote = debtSwapQuote
  return input
}

// The SDK's post-migration disable is a second signed authorization appended to
// the batch. Without signatures the revoke is a plain tx sent afterwards.
const shouldRemoveInboundExternalAuthorization = (connectorId: string, useSignatures: boolean) =>
  connectorId === MORPHO_CONNECTOR_ID && useSignatures

const getInboundExternalMigrationAuthorizationRequest = async (
  input: InboundExternalMigrationInput,
  useSignatures = signaturesEnabled.value,
): Promise<MigrationAuthorizationRequest | undefined> => {
  if (!chainId.value) {
    throw new Error('Migration inputs are incomplete')
  }
  const migrationChainId = input.position.chainId
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
  return getMigrationAuthorization({
    direction: 'external-to-euler',
    connectorId: input.source.connectorId,
    chainId: migrationChainId,
    owner: input.owner,
    position: input.position,
    positionRef: input.source.ref,
    target: input.eulerTarget,
    removeAuthorizationAfterMigration: input.source.connectorId === MORPHO_CONNECTOR_ID && useSignatures,
    // Without signatures the connectors return msg.sender grants to send as
    // their own transactions instead of an EIP-712 message to sign.
    authorizationKind: useSignatures ? 'typedData' : 'transaction',
    deadline,
  })
}

const buildInboundExternalMigrationCalldataPreview = async (
  input: InboundExternalMigrationInput,
  account: Account<IHasVaultAddress>,
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  useSignatures: boolean,
  prefetch?: PluginPrefetchData,
): Promise<TransactionPlanPrepared> => {
  if (!chainId.value) {
    throw new Error('Migration inputs are incomplete')
  }
  const migrationChainId = input.position.chainId
  const authorization = authorizationRequest
    ? buildPlaceholderMigrationAuthorization(authorizationRequest)
    : undefined
  const plan = await planCrossProtocolMigration({
    direction: 'external-to-euler',
    connectorId: input.source.connectorId,
    chainId: migrationChainId,
    owner: input.owner,
    position: input.position,
    positionRef: input.source.ref,
    target: input.eulerTarget,
    authorization,
    removeAuthorizationAfterMigration: shouldRemoveInboundExternalAuthorization(input.source.connectorId, useSignatures),
    collateralSwapQuote: input.collateralSwapQuote,
    debtSwapQuote: input.debtSwapQuote,
    operationName: `${input.source.connectorId}ToEulerMigration`,
  })
  return prepareTransactionPlan(plan, {
    account,
    chainId: migrationChainId,
    prefetch,
    usePermit2: useSignatures,
  })
}

const buildInboundExternalMigrationSimulationResult = async (
  input: InboundExternalMigrationInput,
  authorizationRequest?: MigrationAuthorizationRequest,
  account?: Account<IHasVaultAddress>,
  useSignatures = signaturesEnabled.value,
) => {
  if (!chainId.value) {
    throw new Error('Migration inputs are incomplete')
  }
  const migrationChainId = input.position.chainId
  return planCrossProtocolMigrationSimulation({
    direction: 'external-to-euler',
    connectorId: input.source.connectorId,
    chainId: migrationChainId,
    owner: input.owner,
    position: input.position,
    positionRef: input.source.ref,
    target: input.eulerTarget,
    authorizationRequest,
    removeAuthorizationAfterMigration: shouldRemoveInboundExternalAuthorization(input.source.connectorId, useSignatures),
    collateralSwapQuote: input.collateralSwapQuote,
    debtSwapQuote: input.debtSwapQuote,
    account,
    operationName: `${input.source.connectorId}ToEulerMigration`,
  })
}

const prefetchInboundExternalMigrationPlugins = async (
  plan: TransactionPlan,
  account: Account<IHasVaultAddress>,
): Promise<PluginPrefetchData | undefined> => {
  try {
    return await prefetchPluginData(plan, { account })
  }
  catch (err) {
    logWarn('externalMigration/prefetchPluginData', err)
    return undefined
  }
}

const prepareInboundExternalMigrationPreview = async (): Promise<InboundExternalMigrationPreview> => {
  const key = inboundExternalMigrationPreviewKey.value
  if (!key) throw new Error('Migration inputs are incomplete')

  const cached = inboundExternalMigrationPreview.value
  if (cached?.key === key) return cached
  if (inboundExternalMigrationPreviewPromise && inboundExternalMigrationPreviewPromiseKey === key) {
    return inboundExternalMigrationPreviewPromise
  }

  const requestId = ++inboundExternalMigrationPreviewRequestId
  inboundExternalMigrationPreviewPromiseKey = key
  const promise = (async () => {
    const useSignatures = signaturesEnabled.value
    const input = await buildInboundExternalMigrationInput()
    const account = currentPlanAccount()
    if (!account) throw new Error('Migration inputs are incomplete')
    const authorizationRequest = await getInboundExternalMigrationAuthorizationRequest(input, useSignatures)
    const simulationResult = await buildInboundExternalMigrationSimulationResult(input, authorizationRequest, account, useSignatures)
    const prefetch = await prefetchInboundExternalMigrationPlugins(simulationResult.plan, account)
    // Without signatures the authorization is granted by a standalone tx, so the
    // simulation plan (authorization item filtered out) is already the exact
    // calldata that executes — no stub-signed preview plan needed.
    const [tenderlyPrepared, previewPrepared] = await Promise.all([
      prepareTransactionPlan(simulationResult.plan, {
        account,
        chainId: input.position.chainId,
        prefetch,
        usePermit2: useSignatures,
      }),
      useSignatures
        ? buildInboundExternalMigrationCalldataPreview(input, account, authorizationRequest, useSignatures, prefetch)
        : Promise.resolve(undefined),
    ])
    const calldataPrepared = previewPrepared ?? tenderlyPrepared
    const observedBlock = await rpcClient.value?.getBlockNumber().catch((err) => {
      logWarn('externalMigration/previewBlock', err)
      return undefined
    })

    if (requestId !== inboundExternalMigrationPreviewRequestId || key !== inboundExternalMigrationPreviewKey.value) {
      throw new Error(STALE_INBOUND_EXTERNAL_MIGRATION_PREVIEW_ERROR)
    }

    const preview: InboundExternalMigrationPreview = {
      key,
      useSignatures,
      bundledReview: !useSignatures && isSafeWallet.value && !!authorizationRequest,
      input,
      account,
      tenderlySimulation: {
        plan: simulationResult.plan,
        prepared: tenderlyPrepared,
        stateOverrides: simulationResult.stateOverrides,
      },
      calldataPrepared,
      compilerResult: simulationResult,
      ...(observedBlock === undefined ? {} : { observedBlock }),
      ...(authorizationRequest ? { authorizationRequest } : {}),
      ...(prefetch ? { prefetch } : {}),
    }
    inboundExternalMigrationPreview.value = preview
    inboundExternalAuthorizationConnector.value = authorizationRequest ? input.source.connectorId : null
    return preview
  })()

  inboundExternalMigrationPreviewPromise = promise
  promise.then(
    () => {
      if (inboundExternalMigrationPreviewPromise === promise) {
        inboundExternalMigrationPreviewPromise = null
        inboundExternalMigrationPreviewPromiseKey = ''
      }
    },
    () => {
      if (inboundExternalMigrationPreviewPromise === promise) {
        inboundExternalMigrationPreviewPromise = null
        inboundExternalMigrationPreviewPromiseKey = ''
      }
    },
  )

  return promise
}

const clearInboundExternalMigrationPreview = () => {
  inboundExternalMigrationPreviewRequestId++
  inboundExternalMigrationPreview.value = null
  inboundExternalMigrationPreviewPromise = null
  inboundExternalMigrationPreviewPromiseKey = ''
}

const warmInboundExternalMigrationPreview = useDebounceFn(async () => {
  if (!inboundExternalMigrationPreviewKey.value) return
  try {
    await prepareInboundExternalMigrationPreview()
  }
  catch (err) {
    if (err instanceof Error && err.message === STALE_INBOUND_EXTERNAL_MIGRATION_PREVIEW_ERROR) return
    logWarn('externalMigration/preparePreview', err)
  }
}, 150)

const targetDebtVaultAddress = computed(() =>
  isExternalSourceRoute.value || typeof route.query.to !== 'string' ? '' : normalizeVaultAddress(route.query.to),
)
const targetCollateralVaultAddress = computed(() =>
  isExternalSourceRoute.value || typeof route.query.targetCollateral !== 'string' ? '' : normalizeVaultAddress(route.query.targetCollateral),
)
const consumedTargetDebtVaultAddress = ref('')
const consumedTargetCollateralVaultAddress = ref('')

watch(targetDebtVaultAddress, (address) => {
  if (!address || address !== consumedTargetDebtVaultAddress.value) {
    consumedTargetDebtVaultAddress.value = ''
  }
})
watch(targetCollateralVaultAddress, (address) => {
  if (!address || address !== consumedTargetCollateralVaultAddress.value) {
    consumedTargetCollateralVaultAddress.value = ''
  }
})

const consumeTargetDebtQuery = () => {
  const address = targetDebtVaultAddress.value
  if (address) consumedTargetDebtVaultAddress.value = address
  clearRouteQueryKeys(['to'])
}
const consumeTargetCollateralQuery = () => {
  const address = targetCollateralVaultAddress.value
  if (address) consumedTargetCollateralVaultAddress.value = address
  clearRouteQueryKeys(['targetCollateral'])
}

watch([debtTargetVaults, targetDebtVaultAddress], ([vaults, targetAddress]) => {
  if (!targetAddress || targetDebtVault.value || consumedTargetDebtVaultAddress.value === targetAddress) return
  const vault = vaults.find(candidate => normalizeVaultAddress(candidate.address) === targetAddress)
  if (vault) {
    targetDebtVault.value = vault
    consumeTargetDebtQuery()
  }
}, { immediate: true })
watch([collateralTargetVaults, targetCollateralVaultAddress], ([vaults, targetAddress]) => {
  if (!targetAddress || targetCollateralVault.value || consumedTargetCollateralVaultAddress.value === targetAddress) return
  const vault = vaults.find(candidate => normalizeVaultAddress(candidate.address) === targetAddress)
  if (vault) {
    targetCollateralVault.value = vault
    consumeTargetCollateralQuery()
  }
}, { immediate: true })

watch(debtTargetVaults, (vaults) => {
  if (!targetDebtVault.value) return
  const exists = vaults.some(vault => normalizeVaultAddress(vault.address) === normalizeVaultAddress(targetDebtVault.value?.address))
  if (!exists) targetDebtVault.value = undefined
})
watch(collateralTargetVaults, (vaults) => {
  if (!targetCollateralVault.value) return
  const exists = vaults.some(vault => normalizeVaultAddress(vault.address) === normalizeVaultAddress(targetCollateralVault.value?.address))
  if (!exists) targetCollateralVault.value = undefined
})
watch(isExternalSourceRoute, (enabled) => {
  if (enabled) void loadExternalPositions()
}, { immediate: true })
watch(externalPositionKey, () => {
  if (!isExternalSourceRoute.value) return
  targetDebtVault.value = undefined
  targetCollateralVault.value = undefined
  clearSimulationError()
  resetCollateralQuotes()
  resetDebtQuotes()
  resetExternalCollateralQuotes()
  resetExternalDebtQuotes()
  inboundExternalAuthorizationConnector.value = null
})
watch([targetCollateralVault, () => slippage.value, currentCollateralAssets], () => {
  clearSimulationError()
  resetCollateralQuotes()
  void requestCollateralQuotes()
})
watch([targetDebtVault, () => slippage.value, currentDebt], () => {
  clearSimulationError()
  resetDebtQuotes()
  void requestDebtQuotes()
})
watch([targetCollateralVault, () => slippage.value, currentCollateralAssets, externalCollateralAsset, inboundExternalOwner], () => {
  clearSimulationError()
  resetExternalCollateralQuotes()
  void requestExternalCollateralQuotes()
})
watch([targetDebtVault, () => slippage.value, currentDebt, externalDebtAsset, eulerPeripheryAddresses, inboundExternalOwner], () => {
  clearSimulationError()
  resetExternalDebtQuotes()
  void requestExternalDebtQuotes()
})
watch([inboundExternalOwner, externalPosition], () => {
  inboundExternalEulerAccount.value = null
  inboundExternalEulerAccountKey.value = ''
})
watch([selectedCollateralQuote, selectedDebtQuote], () => {
  clearSimulationError()
})
watch([selectedExternalCollateralQuote, selectedExternalDebtQuote], () => {
  clearSimulationError()
})
watch(inboundExternalMigrationPreviewKey, (key) => {
  clearInboundExternalMigrationPreview()
  inboundExternalAuthorizationConnector.value = null
  if (key) void warmInboundExternalMigrationPreview()
}, { immediate: true })
watch(
  [sourceDebtVault, sourceCollateralVault, targetDebtVault, targetCollateralVault],
  ([sourceDebt, sourceCollateral, targetDebt, targetCollateral]) => {
    const tokens: Address[] = []
    const seen = new Set<string>()
    const push = (addr?: string) => {
      if (!addr) return
      const key = addr.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      tokens.push(addr as Address)
    }
    push(sourceDebt?.asset.address)
    push(sourceCollateral?.asset.address)
    push(targetDebt?.asset.address)
    push(targetCollateral?.asset.address)
    if (tokens.length) void primeSlotHintsFor(tokens)
  },
  { immediate: true },
)

const resolveSelectedVault = <T extends EVault | EulerEarn | SecuritizeCollateralVault>(
  vaults: T[],
  selectedIndex: number,
  selectedOption?: CollateralOption,
): T | undefined => {
  const selectedAddress = normalizeVaultAddress(selectedOption?.vaultAddress)
  if (selectedAddress) {
    const selected = vaults.find(vault => normalizeVaultAddress(vault.address) === selectedAddress)
    if (selected) return selected
  }
  return vaults[selectedIndex]
}

const onDebtVaultChange = (selectedIndex: number, selectedOption?: CollateralOption) => {
  clearSimulationError()
  const selected = resolveSelectedVault(debtSelectionVaults.value, selectedIndex, selectedOption)
  if (!selected) return
  if (isExternalSourceRoute.value) {
    targetDebtVault.value = selected as EVault
    return
  }
  if (!sourceDebtVault.value) return
  consumeTargetDebtQuery()
  if (normalizeVaultAddress(selected.address) === normalizeVaultAddress(sourceDebtVault.value.address)) {
    targetDebtVault.value = undefined
    return
  }
  targetDebtVault.value = selected as EVault
}

const onCollateralVaultChange = (selectedIndex: number, selectedOption?: CollateralOption) => {
  clearSimulationError()
  const selected = resolveSelectedVault(collateralSelectionVaults.value, selectedIndex, selectedOption)
  if (!selected) return
  if (isExternalSourceRoute.value) {
    if (!isSecuritizeCollateralVault(selected)) {
      targetCollateralVault.value = selected as SupplyTargetVault
    }
    return
  }
  if (!sourceCollateralVault.value) return
  consumeTargetCollateralQuery()
  if (normalizeVaultAddress(selected.address) === normalizeVaultAddress(sourceCollateralVault.value.address)) {
    targetCollateralVault.value = undefined
    return
  }
  // EulerEarn vaults are only offered on the external route.
  if (!isSecuritizeCollateralVault(selected) && !isEulerEarn(selected)) {
    targetCollateralVault.value = selected as EVault
  }
}

const externalDebtCompatibleNote = computed(() => {
  const debt = externalDebtAsset.value?.symbol
  const collateral = externalCollateralAsset.value?.symbol
  if (!debt || !collateral || targetCollateralVault.value) return undefined
  return `Debt vaults matching ${debt} with LTV support for ${collateral} collateral`
})
const externalCollateralCompatibleNote = computed(() => {
  if (externalIsSupplyOnly.value) return ''
  const collateral = externalCollateralAsset.value?.symbol
  const debt = externalDebtAsset.value?.symbol
  if (!collateral || !debt || targetDebtVault.value) return undefined
  return `Collateral vaults matching ${collateral} and accepted by ${debt} debt vaults`
})

const openSlippageSettings = () => {
  modal.open(SlippageSettingsModal)
}

const submitCowSwapCollateralSwap = async () => {
  if (!sourceCollateralEVault.value || !targetCollateralEVault.value || !selectedCollateralQuote.value || !address.value) return
  if (validationError.value) return

  cowSwapExecution.reset()

  const chainId = currentChainId.value ?? 0
  const chainConfig = getCowSwapChainConfig(chainId)
  if (!chainConfig) {
    showError('CoW is not available on this network')
    return
  }

  if (currentCollateralShares.value <= 0n) {
    showError('Collateral share balance is unavailable')
    return
  }

  const orderAmounts = getCowSwapQuoteOrderAmounts(selectedCollateralQuote.value, {
    slippage: slippage.value,
    slippageTarget: 'buyAmount',
  })
  if (!orderAmounts) {
    showError('Invalid CoW quote: missing order amounts')
    return
  }
  const { sellAmount, buyAmount } = orderAmounts

  const sdkAccount = planAccount.value
  if (!sdkAccount) {
    showError('Account not ready')
    return
  }

  const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
  const cowParams: CowSwapCollateralSwapExecuteParams = {
    chainId,
    account: sdkAccount,
    swapQuote: selectedCollateralQuote.value,
    slippage: slippage.value,
    validTo,
    disableSourceCollateral: true,
  }

  let currentAllowance = 0n
  try {
    const client = rpcClient.value
    if (client) {
      currentAllowance = await client.readContract({
        address: sourceCollateralEVault.value.address as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address.value as Address, chainConfig.vaultRelayer],
        authorizationList: undefined,
      }) as bigint
    }
  }
  catch {
    // Default to showing the approval step.
  }

  const fromVault = sourceCollateralEVault.value
  const toVault = targetCollateralEVault.value
  const fromAsset = fromVault.asset
  const toAsset = toVault.asset
  const fromShareAmount = trimTrailingZeros(formatUnits(sellAmount, Number(fromAsset.decimals)))
  const fromAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(fromVault, sellAmount), Number(fromAsset.decimals)))
  const quotedBuyAmount = parseCowProviderAmount(selectedCollateralQuote.value.providerData?.buyAmount) ?? buyAmount
  const toAssetAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault, quotedBuyAmount), Number(toAsset.decimals)))
  const toAssetMinAmount = trimTrailingZeros(formatUnits(convertVaultSharesToAssets(toVault, buyAmount), Number(toAsset.decimals)))

  const signSteps: DisplayStep[] = []
  let signIdx = 1
  const approval = buildApprovalSignSteps({
    chainId,
    tokenAddress: fromVault.address as Address,
    currentAllowance,
    requiredAmount: sellAmount,
    label: 'Approve for swap',
    assetInfo: {
      symbol: fromAsset.symbol,
      address: fromVault.address,
      iconAddress: fromAsset.address,
      amount: fromShareAmount,
    },
    startIndex: signIdx,
  })
  signSteps.push(...approval.steps)
  signIdx = approval.nextIndex
  signSteps.push({ index: signIdx++, label: 'Sign EVC permit', isSeparateTx: false })
  signSteps.push({ index: signIdx++, label: 'Sign CoW order', isSeparateTx: false })

  let wrapperIdx = 1
  const wrapperSteps: DisplayStep[] = [
    { index: wrapperIdx++, label: 'Enable collateral', labelSuffix: toAsset.symbol, isSeparateTx: false },
    { index: wrapperIdx++, label: 'Disable source collateral', labelSuffix: fromAsset.symbol, isSeparateTx: false },
    {
      index: wrapperIdx++,
      label: 'Transfer to wallet',
      isSeparateTx: false,
      assetInfo: {
        symbol: fromAsset.symbol,
        address: fromVault.address,
        iconAddress: fromAsset.address,
        amount: fromShareAmount,
      },
    },
    {
      index: wrapperIdx++,
      label: 'Swap',
      isSeparateTx: false,
      assetInfo: { symbol: fromAsset.symbol, address: fromAsset.address, amount: fromAssetAmount },
      toAssetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetAmount },
    },
    {
      index: wrapperIdx++,
      label: 'Verify min received',
      isSeparateTx: false,
      assetInfo: { symbol: toAsset.symbol, address: toAsset.address, amount: toAssetMinAmount },
    },
  ]

  const walletWarningsDescription
    = 'The CoW order and transfer steps use vault-share amounts. Swap and received amounts are shown in underlying assets. '
      + 'The CoW order receiver is your sub-account, not your main wallet - your wallet may flag this as a mismatch. '
      + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

  openCowSwapReviewModal(modal, {
    signSteps,
    wrapperSteps,
    walletWarningsDescription,
    execution: cowSwapExecution,
    orderStatus: cowSwapOrderStatus,
    executeParams: cowParams,
    quoteFetchedAt: collateralQuoteFetchedAt.value,
    logPrefix: 'refinance/collateral-cowswap',
  })
}

function schedulePostMigrationRefreshes(refreshAddress: Address) {
  scheduleExternalMigrationRefreshes()
  for (const delay of POST_EXTERNAL_MIGRATION_REFRESH_DELAYS_MS) {
    setTimeout(() => {
      if (refreshAddress) {
        void refreshAllPositions(undefined, refreshAddress)
      }
    }, delay)
  }
}

watch(() => cowSwapOrderStatus.orderStatus.value, (status) => {
  if (!status?.terminal) return
  if (status.type === 'traded' || status.type === 'fulfilled') {
    refreshAllPositions(undefined, address.value || '')
    modal.close()
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: route.query.network } })
      cowSwapExecution.reset()
    }, 400)
  }
})

const reviewInboundExternalMigration = async () => {
  const reviewAsset = externalDebtAsset.value ?? externalCollateralAsset.value
  if (isOperationBlocked.value || directInboundMigrationDisabledReason.value || !canReviewInboundExternalMigration.value || !reviewAsset) return
  isPreparing.value = true
  clearSimulationError()
  try {
    inboundExternalAuthorizationConnector.value = null
    const preview = await prepareInboundExternalMigrationPreview()
    inboundExternalAuthorizationConnector.value = preview.authorizationRequest ? preview.input.source.connectorId : null
    const intent = createInboundMigrationIntent(preview)
    await openReviewState([intent], {
      presentationKind: 'migration',
      review: {
        type: 'migration',
        asset: reviewAsset,
        amount: formatUnits(reviewAsset.amount, Number(reviewAsset.decimals)),
        signatureSteps: buildInboundExternalMigrationSignatureSteps(preview.authorizationRequest, preview.useSignatures, preview.bundledReview),
        postSteps: buildInboundExternalMigrationRevokeSteps(preview.authorizationRequest, preview.useSignatures, preview.bundledReview),
        calldataUsesPlaceholderSignatures: preview.useSignatures && !!preview.authorizationRequest,
        allowConfirmWithoutPlan: true,
        quoteFetchedAt: effectiveQuoteFetchedAt.value,
        knownAssets: externalMigrationKnownAssets.value,
        swapQuoteOutputs: externalMigrationSwapQuoteOutputs.value,
        submittingLabel: 'Migrating...',
      },
      onResult: (result) => {
        const migration = result.migration
        if (!migration || result.status !== 'submitted') return
        if (migration.warning) showWarning('Migration completed with a warning', { description: migration.warning })
      },
      onConfirmed: () => {
        schedulePostMigrationRefreshes(preview.input.owner)
      },
      onSucceeded: () => {
        const redirectPath = preview.input.eulerTarget.borrowVault ? '/portfolio' : '/portfolio/saving'
        setTimeout(() => void router.replace({ path: redirectPath, query: { network: route.query.network } }), MODAL_CLOSE_REDIRECT_DELAY_MS)
      },
      onFailed: (cause) => { showError(cause instanceof Error ? cause.message : 'Migration failed') },
    })
  }
  catch (err) {
    logWarn('externalMigration/review', err)
    showError(err instanceof Error ? err.message : 'Failed to prepare migration')
  }
  finally {
    isPreparing.value = false
  }
}

const createInboundMigrationIntent = (preview: InboundExternalMigrationPreview) => {
  const { input, useSignatures, authorizationRequest } = preview
  const bounds = [
    { kind: 'maximum-input' as const, token: input.source.collateral.address, amount: input.source.collateral.amount },
    ...(input.source.debt
      ? [{ kind: 'maximum-input' as const, token: input.source.debt.address, amount: input.source.debt.amount }]
      : []),
  ]
  return createMigrationIntent({
    args: {
      direction: 'external-to-euler',
      connectorId: input.source.connectorId,
      owner: input.owner,
      positionRef: input.source.ref,
      target: input.eulerTarget,
      collateralSwapQuote: input.collateralSwapQuote,
      debtSwapQuote: input.debtSwapQuote,
      removeAuthorizationAfterMigration: shouldRemoveInboundExternalAuthorization(input.source.connectorId, useSignatures),
      operationName: `${input.source.connectorId}ToEulerMigration`,
      authorizationKind: useSignatures ? 'typedData' : 'transaction',
    },
    authorizationRequest,
    ...(preview.observedBlock === undefined
      ? {}
      : {
          previewCompilation: {
            result: preview.compilerResult,
            observedBlock: preview.observedBlock,
            ...(preview.prefetch ? { prefetch: preview.prefetch } : {}),
            prepared: preview.calldataPrepared,
          },
        }),
    source: 'position/external-migration-inbound',
    subAccounts: [input.owner, input.eulerTarget.eulerAccount],
    bounds,
  })
}

const addInboundExternalMigrationToBatch = async () => {
  const reviewAsset = externalDebtAsset.value ?? externalCollateralAsset.value
  if (!canAddToBatch.value || !reviewAsset) return
  clearSimulationError()
  try {
    inboundExternalAuthorizationConnector.value = null
    const preview = await prepareInboundExternalMigrationPreview()
    const input = preview.input
    inboundExternalAuthorizationConnector.value = preview.authorizationRequest ? input.source.connectorId : null
    const sourceCollateralSymbol = input.source.collateral.symbol
    const sourceDebtSymbol = input.source.debt?.symbol
    const targetCollateral = targetCollateralVault.value
    const targetDebt = targetDebtVault.value

    if (!targetCollateral || (input.source.debt && !targetDebt)) {
      throw new Error('Migration inputs are incomplete')
    }

    const positionLabel = sourceDebtSymbol
      ? `${sourceCollateralSymbol}/${sourceDebtSymbol}`
      : sourceCollateralSymbol

    const { useSignatures } = preview
    const intent = createInboundMigrationIntent(preview)

    await addBatchEntry({
      intent,
      label: `Migrate ${positionLabel} to Euler`,
      nameOverride: `Migrate ${positionLabel}`,
      stateOverrides: preview.tenderlySimulation.stateOverrides,
      subAccount: input.eulerTarget.eulerAccount,
      refreshExternalMigrationPositions: true,
      review: {
        type: 'migration',
        asset: reviewAsset,
        amount: formatUnits(reviewAsset.amount, Number(reviewAsset.decimals)),
        // Add-time rows describe the sequential fallback. A latched Safe review
        // uses rows from the exact bundled resolution instead.
        signatureSteps: buildInboundExternalMigrationSignatureSteps(preview.authorizationRequest, useSignatures, false),
        postSteps: buildInboundExternalMigrationRevokeSteps(preview.authorizationRequest, useSignatures, false),
        displayPlan: preview.calldataPrepared.plan,
        quoteFetchedAt: effectiveQuoteFetchedAt.value,
        knownAssets: externalMigrationKnownAssets.value,
        swapQuoteOutputs: externalMigrationSwapQuoteOutputs.value,
      },
    })

    if (targetDebt) {
      redirectAfterAdd('/portfolio', {
        subAccount: input.eulerTarget.eulerAccount,
        vault: targetDebt.address,
        collateral: targetCollateral.address,
      })
      return
    }

    redirectAfterAdd('/portfolio/saving', {
      subAccount: input.eulerTarget.eulerAccount,
      vault: targetCollateral.address,
    })
  }
  catch (err) {
    logWarn('externalMigration/batchReview', err)
    showError(err instanceof Error ? err.message : 'Failed to add migration to batch')
  }
}

const addToBatch = async () => {
  if (isAddingToBatch.value || !canAddToBatch.value) return
  isAddingToBatch.value = true
  try {
    if (isExternalSourceRoute.value) {
      await addInboundExternalMigrationToBatch()
      return
    }
    await guardWithPriceImpact(async () => {
      if (!canAddToBatch.value || !sourceDebtVault.value || !sourceCollateralVault.value) return

      const refinanceInput = buildRefinanceInput({
        collateralQuote: selectedCollateralQuote.value,
        debtQuote: selectedDebtQuote.value,
      })
      const refinanceAccount = subAccount.value as Address
      const sourceCollateralSymbol = sourceCollateralVault.value.asset.symbol
      const sourceDebtSymbol = sourceDebtVault.value.asset.symbol
      const targetCollateralSymbol = effectiveCollateralVault.value.asset.symbol
      const targetDebtSymbol = effectiveDebtVault.value.asset.symbol
      const sourceDebtAsset = sourceDebtVault.value.asset
      const debtAmount = formatVaultAmount(currentDebt.value, sourceDebtVault.value)
      const vaultAmounts = refinanceVaultAmounts.value
      const quoteFetchedAt = effectiveQuoteFetchedAt.value
      const swapReviewInfo = refinanceSwapReviewInfo.value
      const collateralChanged = hasCollateralChange.value
      const debtChanged = hasDebtChange.value

      await addBatchEntry({
        label: `Refinance ${sourceCollateralSymbol}/${sourceDebtSymbol} to ${targetCollateralSymbol}/${targetDebtSymbol}`,
        nameOverride: `Refinance ${sourceCollateralSymbol}/${sourceDebtSymbol}`,
        intent: createRefinanceIntent(refinanceInput, 'position/refinance'),
        subAccount: refinanceAccount,
        review: {
          type: 'refinance',
          asset: sourceDebtAsset,
          amount: debtAmount,
          quoteFetchedAt,
          collateralChanged,
          debtChanged,
          vaultAmounts,
          sourceDebtVault: sourceDebtVault.value.address,
          sourceCollateralVaults: sourceCollateralVaultAddresses.value,
          ...swapReviewInfo,
        },
      })
      redirectAfterAdd('/portfolio', { subAccount: refinanceAccount })
    })
  }
  finally {
    isAddingToBatch.value = false
  }
}

const submit = async () => {
  if (isOperationBlocked.value) return
  if (isExternalSourceRoute.value) {
    await reviewInboundExternalMigration()
    return
  }
  if (isPreparing.value || isGeoBlocked.value || isSubmitDisabled.value) return
  isPreparing.value = true
  try {
    await guardWithPriceImpact(async () => {
      if (isSubmitDisabled.value || !sourceDebtVault.value) return

      if (isSelectedCollateralCowSwapProvider.value) {
        await submitCowSwapCollateralSwap()
        return
      }

      preparedPlan.value = null
      plan.value = null
      const refinanceInput = buildRefinanceInput()
      const intent = createRefinanceIntent(refinanceInput, 'position/refinance')
      try {
        plan.value = await planRefinancePosition({ ...refinanceInput, account: currentPlanAccount() })
        preparedPlan.value = await prepareTransactionPlan(plan.value, { account: currentPlanAccount(), intents: [intent] })
      }
      catch (e) {
        logWarn('refinance/buildPlan', e)
        showError('Failed to build transaction')
        return
      }

      const ok = preparedPlan.value
        ? await runPreparedSimulation(preparedPlan.value, buildRefinanceStateOverrideOptions(), undefined, [intent])
        : await runSimulation(plan.value, buildRefinanceStateOverrideOptions())
      if (!ok) return

      if (!plan.value) return
      await openReviewState([intent], {
        presentationKind: 'refinance',
        review: {
          type: 'refinance',
          asset: sourceDebtVault.value.asset,
          amount: formatVaultAmount(currentDebt.value, sourceDebtVault.value),
          quoteFetchedAt: effectiveQuoteFetchedAt.value,
          vaultAmounts: refinanceVaultAmounts.value,
          ...refinanceSwapReviewInfo.value,
          submittingLabel: 'Submitting...',
        },
        onSucceeded: () => {
          setTimeout(() => {
            router.replace({ path: '/portfolio', query: { network: route.query.network } })
          }, 400)
        },
        onFailed: (cause) => {
          showError('Transaction failed')
          logWarn('refinance/send', cause)
        },
      })
    })
  }
  finally {
    isPreparing.value = false
  }
}

function normalizeVaultAddress(addr?: string): string {
  if (!addr) return ''
  try {
    return getAddress(addr)
  }
  catch {
    return ''
  }
}

function sameAssetAddress(a?: string, b?: string): boolean {
  if (!a || !b) return false
  return normalizeVaultAddress(a) === normalizeVaultAddress(b)
}

function isDebtCollateralCompatible(
  debtVault: EVault,
  collateralVault: EVault | EulerEarn | SecuritizeCollateralVault,
): boolean {
  const collateralAddress = normalizeVaultAddress(collateralVault.address)
  return debtVault.collaterals.some(
    ltv => normalizeVaultAddress(ltv.address) === collateralAddress && ltv.borrowLTV > 0,
  )
}

function makeVaultOption(
  vault: EVault | EulerEarn | SecuritizeCollateralVault,
  apy: number | undefined,
  label: string,
): CollateralOption {
  return {
    type: 'vault',
    amount: 0,
    price: 0,
    apy,
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    vaultAddress: vault.address,
    label: getVaultProductName(vault.address) || label,
    disabled: false,
    showBalance: false,
    vault,
  }
}

function formatVaultAmount(amount: bigint | null | undefined, vault?: EVault | EulerEarn | SecuritizeCollateralVault): string {
  if (amount === null || amount === undefined || !vault) return ''
  return trimTrailingZeros(formatUnits(amount, Number(vault.asset.decimals)))
}

function formatExternalAssetAmount(asset?: ExternalMigrationCandidate['collateral'] | null): string {
  if (!asset) return '-'
  return `${formatSmartAmount(formatUnits(asset.amount, Number(asset.decimals)))} ${asset.symbol}`
}

function formatExternalRawAmount(
  amount: bigint | null | undefined,
  asset?: { decimals: number | bigint, symbol: string } | null,
): string {
  if (amount === null || amount === undefined || !asset) return '-'
  return `${formatSmartAmount(formatUnits(amount, Number(asset.decimals)))} ${asset.symbol}`
}

function formatExternalAssetUsd(asset?: ExternalMigrationCandidate['collateral'] | null): string {
  if (!asset || asset.amountUsd === null) return '-'
  return formatUsdValue(asset.amountUsd)
}

function getVaultDisplayName(vault?: EVault | EulerEarn | SecuritizeCollateralVault): string {
  if (!vault) return 'Select Euler vault'
  return getVaultProductName(vault.address) || vault.shares.name || vault.asset.symbol
}

function getVaultMarketAssetLabel(vault?: EVault | EulerEarn | SecuritizeCollateralVault): string {
  if (!vault) return '-'
  return `${getVaultDisplayName(vault)} · ${vault.asset.symbol}`
}

function parseUnsignedIntegerAmount(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  return BigInt(value)
}

const parseCowProviderAmount = parseUnsignedIntegerAmount

function buildQuoteSummary(
  quote: SwapQuote,
  inputVault: EVault | EulerEarn,
  outputVault: EVault | EulerEarn,
  inputField: 'amountIn' | 'amountOut',
  outputField: 'amountIn' | 'amountOut',
) {
  const input = formatUnits(getQuoteAmount(quote, inputField), Number(inputVault.asset.decimals))
  const output = formatUnits(getQuoteAmount(quote, outputField), Number(outputVault.asset.decimals))
  return {
    from: `${formatSmartAmount(input)} ${inputVault.asset.symbol}`,
    to: `${formatSmartAmount(output)} ${outputVault.asset.symbol}`,
    fromExact: `${input} ${inputVault.asset.symbol}`,
    toExact: `${output} ${outputVault.asset.symbol}`,
  }
}

function buildAssetQuoteSummary(
  quote: SwapQuote,
  inputAsset: { decimals: number | bigint, symbol: string },
  outputAsset: { decimals: number | bigint, symbol: string },
  inputField: 'amountIn' | 'amountOut',
  outputField: 'amountIn' | 'amountOut',
) {
  const input = formatUnits(getQuoteAmount(quote, inputField), Number(inputAsset.decimals))
  const output = formatUnits(getQuoteAmount(quote, outputField), Number(outputAsset.decimals))
  return {
    from: `${formatSmartAmount(input)} ${inputAsset.symbol}`,
    to: `${formatSmartAmount(output)} ${outputAsset.symbol}`,
    fromExact: `${input} ${inputAsset.symbol}`,
    toExact: `${output} ${outputAsset.symbol}`,
  }
}

type MigrationReviewAsset = {
  address: string
  symbol: string
  decimals: number | bigint
}

function formatMigrationStepAmount(
  amount: bigint | null | undefined,
  asset: MigrationReviewAsset,
): string | undefined {
  if (amount === null || amount === undefined) return undefined
  return trimTrailingZeros(formatUnits(amount, Number(asset.decimals)))
}

function migrationStepAssetInfo(
  asset: MigrationReviewAsset,
  amount?: bigint | null,
  estimated = false,
): NonNullable<DisplayStep['assetInfo']> {
  return {
    symbol: asset.symbol,
    address: asset.address,
    amount: formatMigrationStepAmount(amount, asset),
    estimated: estimated || undefined,
  }
}

function flattenMigrationAuthorizationRequests(request: MigrationAuthorizationRequest | undefined): MigrationAuthorizationRequest[] {
  if (!request) return []
  return [
    request,
    ...flattenMigrationAuthorizationRequests(request.postMigrationAuthorization),
  ]
}

function getTypedDataAuthorizationValue(request: MigrationAuthorizationRequest | undefined): bigint | undefined {
  if (request?.kind !== 'typedData') return undefined
  return parseUnsignedIntegerAmount((request.typedData.message as { value?: unknown }).value)
}

function buildInboundExternalMigrationSignatureSteps(
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  useSignatures: boolean,
  bundled: boolean,
): DisplayStep[] {
  const sourceCollateral = externalCollateralAsset.value
  if (!sourceCollateral) return []
  if (!useSignatures) {
    return buildMigrationAuthorizationTxSteps(authorizationRequest, 'grant', 1, { bundled })
  }
  if (inboundExternalAuthorizationConnector.value === AAVE_CONNECTOR_ID) {
    const permitValue = getTypedDataAuthorizationValue(authorizationRequest)
    return [{
      index: 1,
      label: 'Signature: Aave permit',
      isSeparateTx: false,
      assetInfo: migrationStepAssetInfo(sourceCollateral, permitValue ?? sourceCollateral.amount),
    }]
  }
  if (inboundExternalAuthorizationConnector.value === MORPHO_CONNECTOR_ID) {
    return flattenMigrationAuthorizationRequests(authorizationRequest).map((request, index) => ({
      index: index + 1,
      label: request.kind === 'typedData' && request.typedData.message.isAuthorized === false
        ? 'Signature: disable Morpho authorization'
        : 'Signature: enable Morpho authorization',
      isSeparateTx: false,
    }))
  }
  if (inboundExternalAuthorizationConnector.value === METAMORPHO_CONNECTOR_ID) {
    // The permit value is denominated in vault shares, so display the
    // underlying position amount as an estimate instead.
    return [{
      index: 1,
      label: 'Signature: Morpho vault permit',
      isSeparateTx: false,
      assetInfo: migrationStepAssetInfo(sourceCollateral, sourceCollateral.amount, true),
    }]
  }
  return []
}

/** Rows for the revoke transactions sent after the batch settles. */
function buildInboundExternalMigrationRevokeSteps(
  authorizationRequest: MigrationAuthorizationRequest | undefined,
  useSignatures: boolean,
  bundled: boolean,
): DisplayStep[] {
  if (!authorizationRequest || useSignatures) return []
  return buildMigrationAuthorizationTxSteps(authorizationRequest, 'revoke', 1, { bundled })
}

function getRoutedVia(provider: string | null, quote: SwapQuote | null): string | null {
  if (!provider) return quote ? 'Not selected' : null
  if (!quote?.route?.length) return provider
  return quote.route.map(route => route.providerName).join(', ')
}

function getOperationVaultAddresses(): string[] {
  if (isExternalSourceRoute.value) {
    const addresses: Array<string | undefined> = [
      targetDebtVault.value?.address,
      targetCollateralVault.value?.address,
    ]
    return addresses.filter((value): value is string => !!value)
  }
  const addresses: Array<string | undefined> = [
    sourceDebtVault.value?.address,
    sourceCollateralVault.value?.address,
    targetDebtVault.value?.address,
    targetCollateralVault.value?.address,
  ]
  return addresses.filter((value): value is string => !!value)
}
</script>

<template>
  <div class="relative flex gap-32">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="refinanceBackFallback"
      always-fallback
    />
    <VaultForm
      page-scroll
      back
      :back-fallback="refinanceBackFallback"
      back-always-fallback
      :title="isExternalSourceRoute ? 'Migrate to Euler' : 'Refinance'"
      :description="isExternalSourceRoute ? 'Select Euler vaults for this external source position.' : 'Move debt, collateral, or both to new vaults in one transaction.'"
      class="flex flex-col gap-16 w-full"
      :loading="isExternalSourceRoute ? isExternalPositionsLoading : isLoading || isPositionsLoading"
      @submit.prevent="submit"
    >
      <template v-if="isExternalSourceRoute">
        <BaseLoadableContent :loading="isExternalPositionsLoading">
          <template v-if="externalPosition">
            <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
              <div class="flex flex-col gap-16 w-full">
                <section class="flex flex-col gap-12">
                  <h2 class="text-h5 text-content-primary">
                    Source
                  </h2>
                  <div class="rounded-12 border border-line-default bg-card p-12">
                    <PortfolioMigrateRow
                      :position="externalPosition"
                      :loading="isSubmitting || isPreparing"
                      :disabled-reason="validationError || undefined"
                      :show-action="false"
                      :hoverable="false"
                    />
                  </div>
                </section>

                <section class="flex flex-col gap-12">
                  <h2 class="text-h5 text-content-primary">
                    {{ externalIsSupplyOnly ? 'Select target vault' : 'Select target vaults' }}
                  </h2>

                  <AssetInput
                    v-model="externalCollateralDisplayAmount"
                    :desc="externalCollateralVaultDescription"
                    :label="externalCollateralVaultLabel"
                    :asset="externalCollateralInputAsset"
                    :vault="targetCollateralVault"
                    :balance="currentCollateralAssets"
                    :collateral-options="collateralSelectionOptions"
                    collateral-modal-product-name="Euler"
                    :collateral-modal-title="externalCollateralVaultPlaceholder"
                    collateral-modal-apy-label="Supply APY"
                    :collateral-modal-compatible-label="externalCollateralCompatibleLabel"
                    :collateral-modal-incompatible-label="externalCollateralIncompatibleLabel"
                    :collateral-modal-compatible-empty-message="externalCollateralCompatibleEmptyMessage"
                    :collateral-modal-compatible-note="externalCollateralCompatibleNote"
                    collateral-modal-force-open
                    selected-source="vault"
                    :selected-vault-address="targetCollateralVault?.address"
                    :asset-selector-placeholder="externalCollateralVaultPlaceholder"
                    :asset-selector-selected="!!targetCollateralVault"
                    :readonly="true"
                    @change-collateral="onCollateralVaultChange"
                  />

                  <UiAlert
                    v-if="!collateralSelectionOptions.length && !isExternalPositionsLoading"
                    :title="externalCollateralOptionsEmptyTitle"
                    :description="externalCollateralOptionsEmptyDescription"
                    variant="warning"
                    size="compact"
                  />

                  <SwapRouteSelector
                    v-if="targetCollateralVault && collateralNeedsSwap"
                    title="Select collateral swap route"
                    :items="activeCollateralRouteItems"
                    :selected-provider="activeCollateralSelectedProvider"
                    :status-label="activeCollateralQuotesStatusLabel"
                    :is-loading="isActiveCollateralQuoteLoading"
                    :empty-message="swapRouteEmptyMessage"
                    @select="selectActiveCollateralProvider"
                    @refresh="onRefreshActiveCollateralQuotes"
                  />

                  <AssetInput
                    v-if="externalDebtAsset"
                    v-model="externalDebtDisplayAmount"
                    :desc="externalDebtVaultDescription"
                    label="Debt vault"
                    :asset="externalDebtInputAsset"
                    :vault="targetDebtVault"
                    :balance="currentDebt"
                    :collateral-options="debtSelectionOptions"
                    collateral-modal-product-name="Euler"
                    collateral-modal-title="Select debt vault"
                    collateral-modal-apy-label="Borrow APY"
                    :collateral-modal-compatible-note="externalDebtCompatibleNote"
                    collateral-modal-force-open
                    selected-source="vault"
                    :selected-vault-address="targetDebtVault?.address"
                    asset-selector-placeholder="Select debt vault"
                    :asset-selector-selected="!!targetDebtVault"
                    :readonly="true"
                    @change-collateral="onDebtVaultChange"
                  />
                </section>

                <UiAlert
                  v-if="externalDebtAsset && !debtSelectionOptions.length && !isExternalPositionsLoading"
                  title="No debt options"
                  description="There are no Euler debt vaults with compatible configuration for this external position."
                  variant="warning"
                  size="compact"
                />

                <SwapRouteSelector
                  v-if="targetDebtVault && debtNeedsSwap"
                  title="Select debt swap route"
                  :items="activeDebtRouteItems"
                  :selected-provider="activeDebtSelectedProvider"
                  :status-label="activeDebtQuotesStatusLabel"
                  :is-loading="isActiveDebtQuoteLoading"
                  :empty-message="swapRouteEmptyMessage"
                  @select="selectActiveDebtProvider"
                  @refresh="onRefreshActiveDebtQuotes"
                />

                <UiAlert
                  v-if="validationError"
                  title="Migration"
                  :description="validationError"
                  :variant="validationError === simulationError ? 'error' : 'warning'"
                  size="compact"
                />
                <UiAlert
                  v-if="activeCollateralQuoteError && collateralNeedsSwap"
                  title="Collateral swap quote"
                  variant="warning"
                  :description="activeCollateralQuoteError"
                  size="compact"
                />
                <UiAlert
                  v-if="activeDebtQuoteError && debtNeedsSwap"
                  title="Debt swap quote"
                  variant="warning"
                  :description="activeDebtQuoteError"
                  size="compact"
                />
                <UiAlert
                  v-if="simulationError"
                  title="Error"
                  variant="error"
                  :description="simulationError"
                  size="compact"
                />

                <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
                  <VaultFormSubmit
                    :disabled="reviewRefinanceDisabled"
                    :loading="isSubmitting || isPreparing"
                    :add-to-batch-loading="isAddingToBatch"
                    :disabled-reason="disabledReasonInfo?.message"
                    :disabled-reason-variant="disabledReasonInfo?.variant"
                    :can-add-to-batch="canAddToBatch"
                    @add-to-batch="addToBatch"
                  >
                    {{ reviewRefinanceLabel }}
                  </VaultFormSubmit>
                </div>
              </div>

              <VaultFormInfoBlock
                :loading="(collateralNeedsSwap && isActiveCollateralQuoteLoading) || (debtNeedsSwap && isActiveDebtQuoteLoading)"
                variant="card"
                allow-overflow
                class="w-full laptop:max-w-[360px]"
              >
                <SummaryRow label="Source">
                  <span class="text-p2 text-right">
                    {{ externalPosition.protocol }}
                  </span>
                </SummaryRow>
                <SummaryRow label="Position">
                  <span class="text-p2 text-right">
                    {{ externalSourcePairLabel }}
                  </span>
                </SummaryRow>
                <SummaryRow :label="externalIsSupplyOnly ? 'Lend target' : 'Collateral target'">
                  <span class="text-p2 text-right">
                    {{ targetCollateralVault ? getVaultMarketAssetLabel(targetCollateralVault) : '-' }}
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="externalDebtAsset"
                  label="Debt target"
                >
                  <span class="text-p2 text-right">
                    {{ targetDebtVault ? getVaultMarketAssetLabel(targetDebtVault) : '-' }}
                  </span>
                </SummaryRow>
                <ProjectedYieldSummaryRow
                  v-if="externalIsSupplyOnly"
                  label="Supply APY"
                  :after="externalSupplyApyAfter"
                  :details="externalSupplyProjectedYieldDetails"
                  estimate-only
                />
                <ProjectedYieldSummaryRow
                  v-else
                  label="ROE"
                  :after="showNextRefinanceMetrics ? roeAfter : null"
                  :details="refinanceProjectedYieldDetails"
                  estimate-only
                />
                <SummaryRow :label="collateralNeedsSwap ? 'Source collateral' : 'Collateral'">
                  <span class="text-p2 text-right">
                    {{ formatExternalAssetAmount(externalCollateralAsset) }}
                  </span>
                </SummaryRow>
                <SummaryRow :label="collateralNeedsSwap ? 'Source collateral value' : 'Collateral value'">
                  <span class="text-p2 text-right">
                    {{ formatExternalAssetUsd(externalCollateralAsset) }}
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="externalDebtAsset"
                  :label="debtNeedsSwap ? 'Source debt' : 'Debt'"
                >
                  <span class="text-p2 text-right">
                    {{ formatExternalRawAmount(inboundBorrowAmountWithBuffer, externalDebtAsset) }}
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="externalDebtAsset"
                  :label="debtNeedsSwap ? 'Source debt value' : 'Debt value'"
                >
                  <span class="text-p2 text-right">
                    {{ formatExternalAssetUsd(externalDebtAsset) }}
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="nextLtv !== null && hasAllRequiredQuotes"
                  label="Target LTV"
                >
                  <span class="text-p2 text-right">
                    {{ formatNumber(nextLtv) }}%
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="nextHealth !== null && hasAllRequiredQuotes"
                  label="Target health"
                >
                  <span class="text-p2 text-right">
                    {{ formatHealthScore(nextHealth) }}
                  </span>
                </SummaryRow>
                <SummaryRow
                  v-if="nextBorrowLtv !== null && hasAllRequiredQuotes"
                  label="Borrow LTV"
                >
                  <span class="text-p2 text-right">
                    {{ formatNumber(nextBorrowLtv) }}%
                  </span>
                </SummaryRow>

                <template v-if="collateralNeedsSwap && collateralSwapSummary">
                  <SummaryRow label="Collateral swap">
                    <p class="text-p2 text-right">
                      <UiExactAmount
                        :exact="`${collateralSwapSummary.fromExact} -> ${collateralSwapSummary.toExact}`"
                        align="end"
                      >
                        {{ collateralSwapSummary.from }} -> {{ collateralSwapSummary.to }}
                      </UiExactAmount>
                    </p>
                  </SummaryRow>
                  <SummaryRow
                    v-if="collateralRoutedVia"
                    label="Collateral route"
                  >
                    <p class="text-p2 text-right">
                      {{ collateralRoutedVia }}
                    </p>
                  </SummaryRow>
                </template>

                <template v-if="debtNeedsSwap && debtSwapSummary">
                  <SummaryRow label="Debt swap">
                    <p class="text-p2 text-right">
                      <UiExactAmount
                        :exact="`${debtSwapSummary.fromExact} -> ${debtSwapSummary.toExact}`"
                        align="end"
                      >
                        {{ debtSwapSummary.from }} -> {{ debtSwapSummary.to }}
                      </UiExactAmount>
                    </p>
                  </SummaryRow>
                  <SummaryRow
                    v-if="debtRoutedVia"
                    label="Debt route"
                  >
                    <p class="text-p2 text-right">
                      {{ debtRoutedVia }}
                    </p>
                  </SummaryRow>
                </template>

                <SummaryRow
                  v-if="collateralNeedsSwap || debtNeedsSwap"
                  label="Slippage tolerance"
                >
                  <button
                    type="button"
                    class="flex items-center gap-6 text-p2"
                    @click="openSlippageSettings"
                  >
                    <span>{{ formatNumber(slippage, 2, 0) }}%</span>
                    <SvgIcon
                      name="edit"
                      class="!w-16 !h-16 text-accent-600"
                    />
                  </button>
                </SummaryRow>
              </VaultFormInfoBlock>
            </div>
          </template>
          <UiAlert
            v-else
            title="External position"
            :description="externalPositionsError || 'This external migration position was not found for the active wallet and network.'"
            variant="warning"
            size="compact"
          />
        </BaseLoadableContent>
      </template>
      <template v-else-if="sourceDebtVault && sourceCollateralVault && effectiveDebtVault && effectiveCollateralVault">
        <VaultLabelsAndAssets
          :vault="sourceDebtVault"
          :assets="[sourceCollateralVault.asset, sourceDebtVault.asset]"
          :assets-label="pairAssetsLabel"
          size="large"
        />
        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-model="collateralDisplayAmount"
              :desc="effectiveCollateralProduct.name"
              label="Collateral vault"
              :asset="effectiveCollateralVault.asset"
              :vault="effectiveCollateralVault"
              :balance="currentCollateralAssets"
              :collateral-options="collateralSelectionOptions"
              collateral-modal-title="Select collateral vault"
              collateral-modal-apy-label="Supply APY"
              selected-source="vault"
              :selected-vault-address="effectiveCollateralVault.address"
              asset-selector-placeholder="Select collateral vault"
              asset-selector-selected
              :readonly="true"
              @change-collateral="onCollateralVaultChange"
            />

            <UiAlert
              v-if="collateralMigrationDisabledReason"
              title="Collateral migration unavailable"
              :description="collateralMigrationDisabledReason"
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-else-if="canChangeCollateral && !collateralTargetVaults.length && !isLoading && !isPositionsLoading"
              title="No collateral options"
              description="There are no target collateral vaults available for the selected debt vault."
              variant="warning"
              size="compact"
            />

            <SwapRouteSelector
              v-if="targetCollateralVault && collateralNeedsSwap"
              title="Select collateral swap route"
              :items="collateralRouteItems"
              :selected-provider="collateralSelectedProvider"
              :status-label="collateralQuotesStatusLabel"
              :is-loading="isCollateralQuoteLoading"
              :empty-message="swapRouteEmptyMessage"
              @select="selectCollateralProvider"
              @refresh="onRefreshCollateralQuotes"
            />

            <AssetInput
              v-model="debtDisplayAmount"
              :desc="effectiveDebtProduct.name"
              label="Debt vault"
              :asset="effectiveDebtVault.asset"
              :vault="effectiveDebtVault"
              :balance="currentDebt"
              :collateral-options="debtSelectionOptions"
              collateral-modal-title="Select debt vault"
              collateral-modal-apy-label="Borrow APY"
              selected-source="vault"
              :selected-vault-address="effectiveDebtVault.address"
              asset-selector-placeholder="Select debt vault"
              asset-selector-selected
              :readonly="true"
              @change-collateral="onDebtVaultChange"
            />

            <UiAlert
              v-if="!debtTargetVaults.length && !isLoading && !isPositionsLoading"
              title="No debt options"
              description="There are no other debt vaults available for the selected collateral vault."
              variant="warning"
              size="compact"
            />

            <SwapRouteSelector
              v-if="targetDebtVault && debtNeedsSwap"
              title="Select debt swap route"
              :items="debtRouteItems"
              :selected-provider="debtSelectedProvider"
              :status-label="debtQuotesStatusLabel"
              :is-loading="isDebtQuoteLoading"
              :empty-message="swapRouteEmptyMessage"
              @select="selectDebtProvider"
              @refresh="onRefreshDebtQuotes"
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="validationError"
              title="Refinance"
              :description="validationError"
              :variant="validationError === healthError ? 'error' : 'warning'"
              size="compact"
            />
            <UiAlert
              v-if="collateralQuoteError && collateralNeedsSwap"
              title="Collateral swap quote"
              variant="warning"
              :description="collateralQuoteError"
              size="compact"
            />
            <UiAlert
              v-if="debtQuoteError && debtNeedsSwap"
              title="Debt swap quote"
              variant="warning"
              :description="debtQuoteError"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
              <VaultFormSubmit
                :disabled="reviewRefinanceDisabled"
                :loading="isSubmitting || isPreparing"
                :add-to-batch-loading="isAddingToBatch"
                :disabled-reason="disabledReasonInfo?.message"
                :disabled-reason-variant="disabledReasonInfo?.variant"
                :can-add-to-batch="canAddToBatch"
                @add-to-batch="addToBatch"
              >
                {{ reviewRefinanceLabel }}
              </VaultFormSubmit>
            </div>
          </div>

          <VaultFormInfoBlock
            :loading="(collateralNeedsSwap && isCollateralQuoteLoading) || (debtNeedsSwap && isDebtQuoteLoading)"
            variant="card"
            allow-overflow
            class="w-full laptop:max-w-[360px]"
          >
            <ProjectedYieldSummaryRow
              label="ROE"
              :before="roeBefore"
              :after="showNextRefinanceMetrics ? roeAfter : null"
              :details="refinanceProjectedYieldDetails"
            />
            <SummaryRow
              label="Liq. price"
              align-top
            >
              <p class="text-p2 text-right inline-flex items-center flex-wrap justify-end gap-x-4">
                <template v-if="currentLiquidationPrice !== null && nextLiquidationPrice !== null && showNextRefinanceMetrics">
                  <span class="text-content-tertiary">{{ formatSmartAmount(liqPriceInvert.invertValue(currentLiquidationPrice)) }}<span class="text-p3 ml-2">{{ currentLiqDisplaySymbol }}</span></span>
                  &rarr; <span class="text-content-primary">{{ formatSmartAmount(liqPriceInvert.invertValue(nextLiquidationPrice)) }}<span class="text-content-tertiary text-p3 ml-2">{{ liqPriceInvert.displaySymbol }}</span></span>
                </template>
                <template v-else>
                  {{ liqPriceInvert.invertValue(currentLiquidationPrice) != null ? formatSmartAmount(liqPriceInvert.invertValue(currentLiquidationPrice)!) : '-' }}
                  <span
                    v-if="liqPriceInvert.invertValue(currentLiquidationPrice) != null"
                    class="text-content-tertiary text-p3"
                  >{{ currentLiqDisplaySymbol }}</span>
                </template>
                <button
                  type="button"
                  class="text-content-tertiary hover:text-content-primary transition-colors inline-flex"
                  @click.stop="liqPriceInvert.toggle"
                >
                  <SvgIcon
                    name="swap-horizontal"
                    class="!w-12 !h-12"
                  />
                </button>
              </p>
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(liqPriceInvert.invertValue(currentPriceRatio), liqPriceInvert.invertValue(currentLiquidationPrice))"
                :after="nextLiquidationPrice !== null && showNextRefinanceMetrics
                  ? formatLiqBuffer(liqPriceInvert.invertValue(nextPriceRatio), liqPriceInvert.invertValue(nextLiquidationPrice))
                  : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="currentLtv !== null ? formatNumber(currentLtv) : undefined"
                :after="nextLtv !== null && showNextRefinanceMetrics ? formatNumber(nextLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="currentHealth !== null ? formatHealthScore(currentHealth) : undefined"
                :after="nextHealth !== null && showNextRefinanceMetrics ? formatHealthScore(nextHealth) : undefined"
              />
            </SummaryRow>
            <SummaryRow label="Borrow LTV">
              <SummaryValue
                :before="currentBorrowLtv !== null ? formatNumber(currentBorrowLtv) : undefined"
                :after="nextBorrowLtv !== null && showNextRefinanceMetrics ? formatNumber(nextBorrowLtv) : undefined"
                suffix="%"
              />
            </SummaryRow>

            <template v-if="collateralNeedsSwap && collateralSwapSummary">
              <SummaryRow label="Collateral swap">
                <p class="text-p2 text-right">
                  <UiExactAmount
                    :exact="`${collateralSwapSummary.fromExact} -> ${collateralSwapSummary.toExact}`"
                    align="end"
                  >
                    {{ collateralSwapSummary.from }} -> {{ collateralSwapSummary.to }}
                  </UiExactAmount>
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="collateralPriceImpact !== null"
                label="Collateral impact"
              >
                <p class="text-p2">
                  {{ formatNumber(collateralPriceImpact, 2, 2) }}%
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="collateralRoutedVia"
                label="Collateral route"
              >
                <p class="text-p2 text-right">
                  {{ collateralRoutedVia }}
                </p>
              </SummaryRow>
            </template>

            <template v-if="debtNeedsSwap && debtSwapSummary">
              <SummaryRow label="Debt swap">
                <p class="text-p2 text-right">
                  <UiExactAmount
                    :exact="`${debtSwapSummary.fromExact} -> ${debtSwapSummary.toExact}`"
                    align="end"
                  >
                    {{ debtSwapSummary.from }} -> {{ debtSwapSummary.to }}
                  </UiExactAmount>
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="debtPriceImpact !== null"
                label="Debt impact"
              >
                <p class="text-p2">
                  {{ formatNumber(debtPriceImpact, 2, 2) }}%
                </p>
              </SummaryRow>
              <SummaryRow
                v-if="debtRoutedVia"
                label="Debt route"
              >
                <p class="text-p2 text-right">
                  {{ debtRoutedVia }}
                </p>
              </SummaryRow>
            </template>

            <SummaryRow
              v-if="collateralNeedsSwap || debtNeedsSwap"
              label="Slippage tolerance"
            >
              <button
                type="button"
                class="flex items-center gap-6 text-p2"
                @click="openSlippageSettings"
              >
                <span>{{ formatNumber(slippage, 2, 0) }}%</span>
                <SvgIcon
                  name="edit"
                  class="!w-16 !h-16 text-accent-600"
                />
              </button>
            </SummaryRow>
          </VaultFormInfoBlock>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
