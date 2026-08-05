<script setup lang="ts">
import { getPositionMultiplier } from '~/utils/vault/apy'
import { withProjectedVaultIntrinsicApy, withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import type { VaultAsset } from '~/types/asset'
import { getHookDisabledWarning, getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { isOpDisabled, OP_BORROW } from '~/utils/vault-hooks'
import { getAssetUsdValueForEstimate, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatio } from '~/utils/sdk-prices'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import type { PortfolioBorrowPosition, VaultEntity, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { ltvToPercent, nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { createRaceGuard } from '~/utils/race-guard'
import {
  formatBorrowMoreInputAmount,
  getBorrowMoreAvailableLiquidityDisplay,
  getBorrowMoreDraftReconciliation,
  getBorrowMoreLtvHeadroomAmount,
  getBorrowMoreMaxBorrowAmount,
  getBorrowMorePositionIdentityKey,
  getBorrowMorePositionLtv,
  getBorrowMoreProjectedLtv,
  reconcileBorrowMoreDraftBeforeYieldRefresh,
} from '~/utils/borrow-more'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { BorrowVaultPair } from '~/types/borrow-pair'
import { OperationReviewModal } from '#components'
import { FixedPoint } from '~/utils/fixed-point'
import {
  getProjectedYieldState,
  getCollateralSnapshotRateLines,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldCampaignInput,
  type ProjectedYieldDetails,
  type ProjectedYieldState,
} from '~/utils/projected-yield'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import { getLayeredVault } from '~/composables/useLayeredVaults'
import { requireReviewedExecution } from '~/utils/reviewed-execution'

const router = useRouter()
const _route = useRoute()
const modal = useModal()
const { error } = useToast()
const { planBorrow, executePreparedPlan } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: planAccount } = usePlanAccount()
const { getBorrowVaultPair } = useVaults()
const { isConnected, address } = useWagmi()
const { isSpyMode, spyAddress } = useSpyMode()
const { chainId } = useEulerAddresses()
const { isPositionsLoading, isPositionsLoaded, getPositionBySubAccountIndex } = useEulerAccount()
const positionIndex = usePositionIndex()
const { getBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const {
  version: rewardsVersion,
  getSupplyRewardApy,
  getBorrowRewardApyForCollaterals,
  getEligibleLoopingRewardApyForCollaterals,
  getBorrowRewardCampaignsForCollaterals,
  getEligibleLoopingRewardCampaignsForCollaterals,
} = useRewardsApy()
const { getCollateralApySnapshot } = usePositionCollateralApy()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

const priceInvert = usePriceInvert(
  () => collateralVault.value?.asset.symbol,
  () => borrowVault.value?.asset.symbol,
)

const ltv = ref(0)
const borrowAmount = ref('')
const collateralAmount = ref('')
// Collateral wallet balance from the central (layer-aware) wallet entity.
const balance = computed(() => collateralVault.value?.asset.address ? getBalance(collateralVault.value.asset.address as Address) : 0n)
const isLoading = ref(false)
const isSubmitting = ref(false)
const isPreparing = ref(false)
const isBalanceLoading = ref(false)
const isEstimatesLoading = ref(false)
const plan = ref<TransactionPlan | null>(null)
const pair: Ref<BorrowVaultPair | undefined> = ref()
const health = ref()
const netAPY = ref()
const liquidationPrice = ref()
const isProjectedRiskAvailable = ref(true)
// Layer-aware: tracks the active batch layer's portfolio so the form reflects
// simulated debt/collateral (a one-shot ref would freeze at the real state).
const position = computed<PortfolioBorrowPosition<VaultEntity> | undefined>(() =>
  (!isConnected.value && !isSpyMode.value) ? undefined : getPositionBySubAccountIndex(+positionIndex),
)
const positionIdentityKey = computed(() => {
  const current = position.value
  if (!current) return ''
  return getBorrowMorePositionIdentityKey({
    chainId: chainId.value,
    account: spyAddress.value || address.value,
    subAccount: current.subAccount,
    collateralVaultAddress: current.collateralVault?.address,
    borrowVaultAddress: current.borrowVault?.address,
  })
})
// Same-position baseline refreshes preserve manual input. Identity changes are
// part of the key so an amount cannot carry into another account or vault pair.
const positionBaselineKey = computed(() => {
  const current = position.value
  if (!current) return ''
  return [
    positionIdentityKey.value,
    current.supplied.toString(),
    current.borrowed.toString(),
    getBorrowMorePositionLtv(current)?.toString() ?? '',
  ].join(':')
})
const userLTV = ref(0)
const currentNetAPY = ref<number>()
const currentHealth = ref<number>()
const currentLiquidationPrice = ref<number>()
const currentUserLTV = ref(0)
const projectedYieldDetails = ref<ProjectedYieldDetails>()
const currentYieldState = ref<ProjectedYieldState>()
const currentRewardCampaigns = ref<ProjectedYieldCampaignInput[]>([])
const currentCollateralSnapshot = shallowRef<CollateralApySnapshot | null>(null)

const getRewardCampaignInputs = (
  snapshot: CollateralApySnapshot,
  borrowVaultAddress: string,
  multiplier: number | null,
): ProjectedYieldCampaignInput[] => [
  ...snapshot.entries
    .filter(entry => entry.supplyUsd > 0)
    .flatMap(entry => entry.supplyCampaigns.map(campaign => ({ campaign, vaultAddress: entry.address }))),
  ...getBorrowRewardCampaignsForCollaterals(borrowVaultAddress, snapshot.collateralAddresses)
    .map(campaign => ({ campaign, vaultAddress: borrowVaultAddress })),
  ...getEligibleLoopingRewardCampaignsForCollaterals(
    borrowVaultAddress,
    snapshot.collateralAddresses,
    multiplier,
  ).map(campaign => ({ campaign, vaultAddress: borrowVaultAddress })),
]

const errorText = computed(() => {
  if (isBalanceLoading.value) {
    return null
  }

  const currentSupplied = position.value?.supplied || 0n
  const newCollateralAmount = valueToNano(collateralAmount.value, collateralVault.value?.asset?.decimals)
  const additionalCollateralNeeded = newCollateralAmount > currentSupplied
    ? newCollateralAmount - currentSupplied
    : 0n

  if (additionalCollateralNeeded > 0n && balance.value < additionalCollateralNeeded) {
    return 'Not enough balance'
  }
  else if ((borrowVault.value?.availableLiquidity ?? 0n) < valueToNano(borrowAmount.value, borrowVault.value?.asset.decimals)) {
    return 'Not enough liquidity in the vault'
  }
  return null
})
const isSubmitDisabled = computed(() => {
  if (!isConnected.value && !isSpyMode.value) return false
  if (pair.value?.borrow && isOpDisabled(pair.value.borrow, OP_BORROW)) return true

  const currentSupplied = position.value?.supplied || 0n
  const newCollateralAmount = valueToNano(collateralAmount.value, collateralVault.value?.asset?.decimals)
  const additionalCollateralNeeded = newCollateralAmount > currentSupplied
    ? newCollateralAmount - currentSupplied
    : 0n

  return (additionalCollateralNeeded > 0n && balance.value < additionalCollateralNeeded)
    || isLoading.value || !isProjectedRiskAvailable.value || !(+collateralAmount.value)
    || ((borrowVault.value?.availableLiquidity ?? 0n) < valueToNano(borrowAmount.value, borrowVault.value?.asset.decimals))
})
const isGeoBlocked = computed(() => {
  const addresses: string[] = []
  if (pair.value?.borrow) addresses.push(pair.value.borrow.address)
  if (pair.value?.collateral) addresses.push(pair.value.collateral.address)
  return isAnyVaultBlockedByCountry(...addresses)
})
const isBorrowRestricted = computed(() =>
  pair.value?.borrow ? isVaultRestrictedByCountry(pair.value.borrow.address) : false)
const reviewBorrowDisabled = computed(() => isGeoBlocked.value || isBorrowRestricted.value || isSubmitDisabled.value)

const disabledReasonInfo = computed((): DisabledReasonInfo | undefined => {
  if (isGeoBlocked.value) return { message: 'This operation is not available in your region', variant: 'warning' }
  if (isBorrowRestricted.value) return { message: 'Borrowing this asset is not available in your region', variant: 'warning' }
  if (!isProjectedRiskAvailable.value) return { message: 'Projected risk estimates are unavailable', variant: 'warning' }
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  return undefined
})
const borrowVault = computed(() => pair.value?.borrow)
const collateralVault = computed(() => pair.value?.collateral)
const projectionBorrowVault = computed(() => {
  const fallback = borrowVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
const projectionCollateralVault = computed(() => {
  const fallback = collateralVault.value
  return fallback ? getLayeredVault(fallback.address, fallback) : undefined
})
useOperationGuard(computed(() => [borrowVault.value?.address, collateralVault.value?.address].filter(Boolean)))
const borrowWarnings = computed(() => {
  if (!borrowVault.value) return []
  return [
    getHookDisabledWarning(borrowVault.value, OP_BORROW),
    getUtilisationWarning(borrowVault.value, 'borrow'),
    getBorrowCapWarning(borrowVault.value),
  ]
})
const pairAssets = computed<VaultAsset[]>(() => [collateralVault.value?.asset, borrowVault.value?.asset].filter((asset): asset is VaultAsset => !!asset))
const pairAssetsLabel = usePositionPairLabel(position)
const priceFixed = computed(() => {
  const collateralPrice = borrowVault.value && collateralVault.value
    ? getCollateralOraclePrice(borrowVault.value, collateralVault.value)
    : undefined
  const borrowPrice = borrowVault.value ? getAssetOraclePrice(borrowVault.value) : undefined
  return FixedPoint.fromValue(conservativePriceRatio(collateralPrice, borrowPrice), 18)
})
priceInvert.autoInvert(() => priceFixed.value.toUnsafeFloat())
const ltvFixed = computed(() => {
  const fn = FixedPoint.fromValue(valueToNano(ltv.value, 4), 4)
  const maxLtv = FixedPoint.fromValue(valueToNano(ltvToPercent(pair.value?.ltv.borrowLTV ?? 0), 4), 4)
  if (fn.gte(maxLtv)) {
    return fn.sub(FixedPoint.fromValue(100n, 4))
  }
  return fn
})
const borrowProduct = useEulerProductOfVault(computed(() => borrowVault.value?.address || ''))
const _collateralProduct = useEulerProductOfVault(computed(() => collateralVault.value?.address || ''))

const availableLiquidity = computed(() => borrowVault.value?.availableLiquidity)
const availableLiquidityDisplay = computed(() => getBorrowMoreAvailableLiquidityDisplay(borrowVault.value))

const loadGuard = createRaceGuard()
const asyncEstimatesGuard = createRaceGuard()
let loadedPositionIdentityKey = ''
const currentYieldGuard = createRaceGuard()
const refreshCurrentYield = async () => {
  const gen = currentYieldGuard.next()
  const currentPosition = position.value
  const currentBorrowVault = projectionBorrowVault.value
  const currentCollateralVault = projectionCollateralVault.value
  currentYieldState.value = undefined
  currentNetAPY.value = undefined
  currentRewardCampaigns.value = []
  currentCollateralSnapshot.value = null
  if (!currentPosition || !currentBorrowVault || !currentCollateralVault) return

  const [collateralSnapshot, borrowUsd] = await Promise.all([
    getCollateralApySnapshot(currentPosition, currentBorrowVault),
    getAssetUsdValueForEstimate(currentPosition.borrowed || 0n, currentBorrowVault, 'off-chain'),
  ])
  if (currentYieldGuard.isStale(gen) || !collateralSnapshot.isComplete || borrowUsd === undefined) return

  const multiplier = getPositionMultiplier(collateralSnapshot.supplyUsd, borrowUsd)
  const loopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
    currentBorrowVault.address,
    collateralSnapshot.collateralAddresses,
    multiplier,
  )
  const currentBorrowRaw = getVaultBorrowApy(currentBorrowVault)
  const currentBorrowApy = withVaultIntrinsicApy(
    currentBorrowRaw,
    currentBorrowVault,
    enableIntrinsicApy.value,
  )
  const state = getProjectedYieldState('net-apy', {
    supplyUsd: collateralSnapshot.supplyUsd,
    baseSupplyApy: collateralSnapshot.weightedBaseSupplyApy ?? getVaultSupplyApy(currentCollateralVault),
    intrinsicSupplyApy: collateralSnapshot.weightedIntrinsicSupplyApy ?? 0,
    supplyRewardApy: collateralSnapshot.weightedSupplyRewardApy ?? getSupplyRewardApy(currentCollateralVault.address),
    borrowUsd,
    baseBorrowApy: currentBorrowRaw,
    intrinsicBorrowApy: currentBorrowApy - currentBorrowRaw,
    borrowRewardApy: getBorrowRewardApyForCollaterals(currentBorrowVault.address, collateralSnapshot.collateralAddresses),
    loopingRewardApy,
  })
  if (currentYieldGuard.isStale(gen)) return
  currentYieldState.value = state ?? undefined
  currentNetAPY.value = state?.total
  currentCollateralSnapshot.value = state ? collateralSnapshot : null
  currentRewardCampaigns.value = getRewardCampaignInputs(
    collateralSnapshot,
    currentBorrowVault.address,
    multiplier,
  )
}
const load = async () => {
  const generation = loadGuard.next()
  currentYieldGuard.next()
  asyncEstimatesGuard.next()
  if (!isConnected.value && !isSpyMode.value) {
    loadedPositionIdentityKey = ''
    isLoading.value = false
    return
  }
  isLoading.value = true
  // `position` is layer-aware; load() seeds the "before" baseline for the
  // currently active real or simulated position.
  const currentPosition = position.value
  if (!currentPosition) {
    loadedPositionIdentityKey = ''
    isLoading.value = false
    return
  }
  const nextPositionIdentityKey = positionIdentityKey.value
  const collateralAddress = currentPosition.collateralVault?.address
  const borrowAddress = currentPosition.borrowVault?.address
  if (!collateralAddress || !borrowAddress) {
    isLoading.value = false
    await router.replace({ path: `/position/${positionIndex}`, query: _route.query })
    return
  }
  const positionLtv = getBorrowMorePositionLtv(currentPosition)
  if (positionLtv === undefined) {
    isLoading.value = false
    await router.replace({ path: `/position/${positionIndex}`, query: _route.query })
    return
  }
  try {
    const nextPair = await getBorrowVaultPair(collateralAddress as string, borrowAddress as string) as BorrowVaultPair
    if (loadGuard.isStale(generation)) return

    const nextUserLTV = Number(formatNumber(ltvToPercent(nanoToValue(positionLtv, 18))))
    const suppliedFixed = FixedPoint.fromValue(
      currentPosition.supplied,
      Number(nextPair.collateral.asset.decimals),
    )
    const currentLtvPercent = ltvToPercent(nanoToValue(positionLtv, 18))
    const nextCurrentHealth = currentLtvPercent <= 0
      ? Infinity
      : ltvToPercent(nextPair.ltv.liquidationLTV) / currentLtvPercent
    const nextPrice = FixedPoint.fromValue(
      conservativePriceRatio(
        getCollateralOraclePrice(nextPair.borrow, nextPair.collateral),
        getAssetOraclePrice(nextPair.borrow),
      ),
      18,
    ).toUnsafeFloat()
    const nextCurrentLiquidationPrice = nextCurrentHealth < 0.1 ? Infinity : nextPrice / nextCurrentHealth

    const nextDraft = getBorrowMoreDraftReconciliation({
      loadedPositionIdentityKey,
      nextPositionIdentityKey,
      isLtvDriven: isLtvDriven.value,
      borrowAmount: borrowAmount.value,
      borrowed: currentPosition.borrowed,
      borrowDecimals: nextPair.borrow.shares.decimals,
      totalCollateral: getTotalCollateralValue(currentPosition),
      baselineLtv: nextUserLTV,
    })

    pair.value = nextPair
    userLTV.value = nextUserLTV
    currentUserLTV.value = nextUserLTV
    collateralAmount.value = trimTrailingZeros(suppliedFixed.toString())
    currentHealth.value = nextCurrentHealth
    currentLiquidationPrice.value = nextCurrentLiquidationPrice
    loadedPositionIdentityKey = nextPositionIdentityKey
    updateBalance()

    await reconcileBorrowMoreDraftBeforeYieldRefresh({
      draft: nextDraft,
      commitDraft: (draft) => {
        isProjectedRiskAvailable.value = true
        isLtvDriven.value = draft.isLtvDriven
        borrowAmount.value = draft.borrowAmount
        ltv.value = draft.ltv
        if (draft.retained) {
          updateSyncEstimates()
          netAPY.value = undefined
          projectedYieldDetails.value = undefined
          isEstimatesLoading.value = true
        }
        else {
          health.value = nextCurrentHealth
          liquidationPrice.value = nextCurrentLiquidationPrice
          netAPY.value = undefined
          projectedYieldDetails.value = undefined
          isEstimatesLoading.value = false
        }
      },
      refreshYield: refreshCurrentYield,
      onYieldError: (e) => {
        if (!loadGuard.isStale(generation)) logWarn('borrow-more/currentYield', e)
      },
    })
    if (loadGuard.isStale(generation)) return
    if (nextDraft.retained) {
      queueAsyncEstimates()
    }
  }
  catch (e) {
    if (loadGuard.isStale(generation)) return
    error('Unable to load Vault')
    console.warn(e)
  }
  finally {
    if (!loadGuard.isStale(generation)) {
      isLoading.value = false
    }
  }
}
// `balance` is now a reactive computed over the wallet entity; this just clears
// the initial loading flag.
const updateBalance = () => {
  isBalanceLoading.value = false
}
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || reviewBorrowDisabled.value) return
  isPreparing.value = true
  try {
    if (!borrowVault.value || !collateralVault.value) {
      return
    }

    try {
      plan.value = await planBorrow({
        vaultAddress: borrowVault.value.address as Address,
        amount: valueToNano(borrowAmount.value || '0', borrowVault.value.shares.decimals),
        borrowAccount: position.value!.subAccount as Address,
        account: planAccount.value,
      })
    }
    catch (e) {
      console.warn('[OperationReviewModal] failed to build plan', e)
      plan.value = null
    }

    if (plan.value) {
      const ok = await runSimulation(plan.value)
      if (!ok) {
        return
      }
    }

    modal.open(OperationReviewModal, {
      props: {
        type: 'borrow',
        asset: borrowVault.value?.asset,
        amount: borrowAmount.value,
        plan: plan.value || undefined,
        subAccount: position.value?.subAccount,
        hasBorrows: (position.value?.borrowed || 0n) > 0n,
        submittingLabel: 'Submitting...',
        onConfirm: async (reviewed: TransactionPlanPrepared | undefined) => {
          await send(reviewed)
        },
      },
    })
  }
  finally {
    isPreparing.value = false
  }
}
// Add this borrow to the transaction batch. Built against the active layer's
// simulated account, so a borrow stacked on a simulated collateral deposit
// borrows against that simulated collateral.
const canAddToBatch = computed(() =>
  !reviewBorrowDisabled.value && !!borrowVault.value && !!position.value && !!(+borrowAmount.value),
)
const addToBatch = async () => {
  if (!canAddToBatch.value || !borrowVault.value || !position.value) return
  const vaultAddress = borrowVault.value.address as Address
  const amount = valueToNano(borrowAmount.value, borrowVault.value.shares.decimals)
  const borrowAccount = position.value.subAccount as Address
  const label = `Borrow ${borrowAmount.value} ${borrowVault.value.asset.symbol}`
  await addBatchEntry({
    label,
    // subAccountSnapshotApplied: the layer account passed by useTxBatch already
    // reflects the simulated (or freshly-fetched base) sub-account state, so the
    // planner must NOT re-fetch it on-chain — that would clobber a simulated
    // collateral deposit from an earlier batch step.
    buildPlan: account => planBorrow({ vaultAddress, amount, borrowAccount, account, subAccountSnapshotApplied: true }),
    subAccount: borrowAccount,
    review: { type: 'borrow', asset: borrowVault.value.asset, amount: borrowAmount.value },
  })
  borrowAmount.value = ''
  redirectAfterAdd('/portfolio', { subAccount: borrowAccount })
}

const send = async (reviewed: TransactionPlanPrepared | undefined) => {
  try {
    isSubmitting.value = true
    await executePreparedPlan(requireReviewedExecution(reviewed))

    modal.close()
    updateBalance()
    setTimeout(() => {
      router.replace({ path: '/portfolio', query: { network: _route.query.network } })
    }, 400)
  }
  catch (e) {
    console.warn(e)
    error('Transaction failed')
  }
  finally {
    isSubmitting.value = false
  }
}
const isLtvDriven = ref(true)

// Reactive borrow amount: uses FixedPoint throughout to avoid precision loss on large bigints.
// Formula: additionalBorrow = borrowed * (newLtv - currentLtv) / currentLtv
const computedBorrowAmount = computed(() => {
  if (!pair.value || !borrowVault.value) return null
  const borrowed = position.value?.borrowed || 0n
  if (borrowed === 0n || currentUserLTV.value <= 0) return null

  const newLtvFP = ltvFixed.value
  const currentLtvFP = FixedPoint.fromValue(valueToNano(currentUserLTV.value, 4), 4)
  if (currentLtvFP.isZero() || newLtvFP.lte(currentLtvFP)) return '0'

  const borrowedFP = FixedPoint.fromValue(borrowed, Number(borrowVault.value.shares.decimals))
  const delta = newLtvFP.subUnsafe(currentLtvFP)
  const additional = borrowedFP.mul(delta).div(currentLtvFP)
  if (additional.isZero() || additional.isNegative()) return '0'
  return trimTrailingZeros(additional.toString())
})
const ltvHeadroomAmount = computed((): bigint | undefined => {
  if (!pair.value || !borrowVault.value || !position.value) return undefined
  return getBorrowMoreLtvHeadroomAmount({
    borrowed: position.value.borrowed || 0n,
    borrowDecimals: borrowVault.value.shares.decimals,
    assetDecimals: borrowVault.value.asset.decimals,
    currentLtvPercent: currentUserLTV.value,
    maxBorrowLtv: pair.value.ltv.borrowLTV,
  })
})
const maxBorrowAmount = computed(() => getBorrowMoreMaxBorrowAmount({
  availableLiquidity: availableLiquidity.value,
  ltvHeadroom: ltvHeadroomAmount.value,
}))
const setMaxBorrowAmount = async () => {
  if (!borrowVault.value || maxBorrowAmount.value === undefined) return
  borrowAmount.value = formatBorrowMoreInputAmount(maxBorrowAmount.value, borrowVault.value.asset.decimals)
  await onBorrowInput()
}

watch(computedBorrowAmount, (val) => {
  if (isLtvDriven.value && val !== null) {
    borrowAmount.value = val
  }
})

const onBorrowInput = async () => {
  isLtvDriven.value = false
  await nextTick()
  if (!position.value) return
  const projectedLtv = getBorrowMoreProjectedLtv({
    borrowed: position.value.borrowed,
    borrowDecimals: borrowVault.value?.shares.decimals || 18,
    additionalBorrowAmount: borrowAmount.value,
    totalCollateral: getTotalCollateralValue(position.value),
  })
  if (projectedLtv !== undefined) {
    isProjectedRiskAvailable.value = true
    ltv.value = projectedLtv
  }
  else {
    isProjectedRiskAvailable.value = false
    asyncEstimatesGuard.next()
    health.value = undefined
    liquidationPrice.value = undefined
    netAPY.value = undefined
    projectedYieldDetails.value = undefined
    isEstimatesLoading.value = false
  }
}
const onLtvInput = () => {
  isProjectedRiskAvailable.value = true
  isLtvDriven.value = true
}
const updateSyncEstimates = () => {
  if (!isProjectedRiskAvailable.value) {
    health.value = undefined
    liquidationPrice.value = undefined
    return
  }
  if (!pair.value) return
  try {
    const newLtvFloat = ltvFixed.value.toUnsafeFloat()
    health.value = newLtvFloat <= 0
      ? Infinity
      : ltvToPercent(pair.value.ltv.liquidationLTV) / newLtvFloat
    liquidationPrice.value = health.value < 1 ? undefined : priceFixed.value.toUnsafeFloat() / health.value
  }
  catch (e) {
    logWarn('borrow-more/syncEstimates', e)
    health.value = undefined
    liquidationPrice.value = undefined
  }
}

const updateAsyncEstimates = useDebounceFn(async (gen: number) => {
  if (asyncEstimatesGuard.isStale(gen)) return
  if (!isProjectedRiskAvailable.value) {
    netAPY.value = undefined
    projectedYieldDetails.value = undefined
    isEstimatesLoading.value = false
    return
  }
  const currentPair = pair.value
  const currentBorrowVault = projectionBorrowVault.value
  const currentCollateralVault = projectionCollateralVault.value
  const currentPosition = position.value
  const currentBorrowAmount = borrowAmount.value
  const baselineState = currentYieldState.value
  const baselineCampaigns = currentRewardCampaigns.value
  const baselineCollateralSnapshot = currentCollateralSnapshot.value
  netAPY.value = undefined
  projectedYieldDetails.value = undefined
  if (!currentPair || !currentBorrowVault || !currentCollateralVault || !currentPosition || !(+currentBorrowAmount > 0)) {
    isEstimatesLoading.value = false
    return
  }
  try {
    const additionalBorrowNano = valueToNano(currentBorrowAmount, currentBorrowVault.shares.decimals)
    const existingBorrow = nanoToValue(currentPosition.borrowed || 0n, currentBorrowVault.shares.decimals)
    const totalBorrow = existingBorrow + +currentBorrowAmount

    const [collateralSnapshot, borrowUsd] = await Promise.all([
      getCollateralApySnapshot(currentPosition, currentBorrowVault, {
        liabilityRateDelta: {
          cashDelta: -additionalBorrowNano,
          borrowsDelta: additionalBorrowNano,
        },
      }),
      getAssetUsdValueForEstimate(totalBorrow, currentBorrowVault, 'off-chain'),
    ])

    if (asyncEstimatesGuard.isStale(gen)) return
    const borrowProjected = collateralSnapshot.liabilityProjectedRates
    if (!borrowProjected || !collateralSnapshot.isComplete || borrowUsd === undefined) {
      netAPY.value = undefined
      projectedYieldDetails.value = undefined
      return
    }

    const currentRaw = getVaultBorrowApy(currentBorrowVault)
    const projectedBorrowApy = withProjectedVaultIntrinsicApy(
      currentRaw,
      nanoToValue(borrowProjected.borrowAPY, 25),
      currentBorrowVault,
      enableIntrinsicApy.value,
    )
    const loopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
      currentBorrowVault.address,
      collateralSnapshot.collateralAddresses,
      getPositionMultiplier(collateralSnapshot.supplyUsd, borrowUsd),
    )
    const multiplier = getPositionMultiplier(collateralSnapshot.supplyUsd, borrowUsd)
    const projectedBorrowRewardApy = getBorrowRewardApyForCollaterals(
      currentBorrowVault.address,
      collateralSnapshot.collateralAddresses,
    )
    const projectedBorrowRaw = nanoToValue(borrowProjected.borrowAPY, 25)
    const state = getProjectedYieldState('net-apy', {
      supplyUsd: collateralSnapshot.supplyUsd,
      baseSupplyApy: collateralSnapshot.weightedBaseSupplyApy ?? getVaultSupplyApy(currentCollateralVault),
      intrinsicSupplyApy: collateralSnapshot.weightedIntrinsicSupplyApy ?? 0,
      supplyRewardApy: collateralSnapshot.weightedSupplyRewardApy ?? getSupplyRewardApy(currentCollateralVault.address),
      borrowUsd,
      baseBorrowApy: projectedBorrowRaw,
      intrinsicBorrowApy: projectedBorrowApy - projectedBorrowRaw,
      borrowRewardApy: projectedBorrowRewardApy,
      loopingRewardApy,
    })
    if (!state) {
      netAPY.value = undefined
      projectedYieldDetails.value = undefined
      return
    }

    const afterCampaigns = getRewardCampaignInputs(
      collateralSnapshot,
      currentBorrowVault.address,
      multiplier,
    )
    netAPY.value = state.total
    projectedYieldDetails.value = {
      metric: 'net-apy',
      before: baselineState,
      after: state,
      rateLines: [
        ...getCollateralSnapshotRateLines(baselineCollateralSnapshot, collateralSnapshot),
        {
          id: `borrow:${currentBorrowVault.address.toLowerCase()}`,
          label: 'Borrow APY',
          symbol: currentBorrowVault.asset.symbol,
          vaultAddress: currentBorrowVault.address,
          before: currentRaw,
          after: projectedBorrowRaw,
        },
      ],
      rewards: mergeProjectedRewardCampaigns(baselineCampaigns, afterCampaigns),
    }
  }
  catch (e) {
    if (asyncEstimatesGuard.isStale(gen)) return
    logWarn('borrow-more/asyncEstimates', e)
    netAPY.value = undefined
    projectedYieldDetails.value = undefined
  }
  finally {
    if (!asyncEstimatesGuard.isStale(gen)) {
      isEstimatesLoading.value = false
    }
  }
}, 500)

const queueAsyncEstimates = () => {
  const gen = asyncEstimatesGuard.next()
  netAPY.value = undefined
  projectedYieldDetails.value = undefined
  if (!isProjectedRiskAvailable.value || !pair.value || !position.value || !(+borrowAmount.value > 0)) {
    isEstimatesLoading.value = false
    return
  }
  isEstimatesLoading.value = true
  updateAsyncEstimates(gen)
}

watch([isPositionsLoaded, positionBaselineKey], ([positionsLoaded]) => {
  if (!positionsLoaded) {
    loadGuard.next()
    currentYieldGuard.next()
    asyncEstimatesGuard.next()
    isLoading.value = false
    return
  }
  void load()
}, { immediate: true })
watch(isConnected, () => {
  updateBalance()
})
watch(address, () => {
  updateBalance()
})
watch(ltv, () => {
  updateSyncEstimates()
})
watch([collateralAmount, borrowAmount], async () => {
  clearSimulationError()
  if (!pair.value) {
    asyncEstimatesGuard.next()
    netAPY.value = undefined
    projectedYieldDetails.value = undefined
    isEstimatesLoading.value = false
    return
  }
  updateSyncEstimates()
  queueAsyncEstimates()
})
watch([
  position,
  () => projectionBorrowVault.value?.totalCash,
  () => projectionBorrowVault.value?.totalBorrowed,
  () => projectionCollateralVault.value?.totalCash,
  () => projectionCollateralVault.value?.totalBorrowed,
], async () => {
  asyncEstimatesGuard.next()
  netAPY.value = undefined
  projectedYieldDetails.value = undefined
  await refreshCurrentYield()
  queueAsyncEstimates()
})
watch([rewardsVersion, enableIntrinsicApy], async () => {
  asyncEstimatesGuard.next()
  netAPY.value = undefined
  projectedYieldDetails.value = undefined
  await refreshCurrentYield()
  queueAsyncEstimates()
})
</script>

<template>
  <div class="relative">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/position/${positionIndex}`"
    />
    <VaultForm
      page-scroll
      back
      :back-fallback="`/position/${positionIndex}`"
      title="Borrow more"
      description="Borrow additional assets against your existing collateral."
      :loading="isLoading || isPositionsLoading"
      class="flex flex-col gap-16"
      @submit.prevent="submit"
    >
      <template v-if="pair">
        <VaultLabelsAndAssets
          v-if="collateralVault && borrowVault"
          :vault="collateralVault"
          :pair-vault="borrowVault"
          :assets="pairAssets"
          :assets-label="pairAssetsLabel"
          size="large"
        />

        <div class="grid gap-16 laptop:grid-cols-[minmax(0,1fr)_360px] laptop:items-start">
          <div class="flex flex-col gap-16 w-full">
            <AssetInput
              v-if="borrowVault"
              v-model="borrowAmount"
              :desc="borrowProduct.name"
              :label="`Borrow ${borrowVault.asset.symbol}`"
              :asset="borrowVault.asset"
              :vault="borrowVault"
              :balance="maxBorrowAmount"
              :maxable="maxBorrowAmount !== undefined"
              :max-handler="setMaxBorrowAmount"
              @input="onBorrowInput"
            />
            <UiRange
              v-model="ltv"
              label="LTV"
              :step="0.1"
              :max="ltvToPercent(pair.ltv.borrowLTV)"
              :min="userLTV"
              :number-filter="(n: number) => `${formatNumber(n, 2, 0)}%`"
              @update:model-value="onLtvInput"
            />

            <UiAlert
              v-if="isGeoBlocked"
              title="Region restricted"
              description="This operation is not available in your region. You can still repay existing debt."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-if="!isGeoBlocked && isBorrowRestricted"
              title="Asset restricted"
              description="Borrowing this asset is not available in your region."
              variant="warning"
              size="compact"
            />
            <UiAlert
              v-show="errorText"
              title="Error"
              variant="error"
              :description="errorText || ''"
              size="compact"
            />
            <UiAlert
              v-if="simulationError"
              title="Error"
              variant="error"
              :description="simulationError"
              size="compact"
            />

            <VaultWarningBanner :warnings="borrowWarnings" />
          </div>

          <VaultFormInfoBlock
            v-if="pair"
            :loading="isEstimatesLoading"
            variant="card"
            class="w-full laptop:max-w-[360px]"
          >
            <SummaryRow label="Available liquidity">
              <UiExactAmount
                v-if="availableLiquidityDisplay"
                class="text-content-primary text-right"
                :exact="availableLiquidityDisplay.exact"
                data-field="available-liquidity"
              >
                {{ availableLiquidityDisplay.display }}
              </UiExactAmount>
              <span
                v-else
                class="text-warning-500"
                data-field="available-liquidity"
              >
                Unknown
              </span>
            </SummaryRow>
            <ProjectedYieldSummaryRow
              label="Net APY"
              :before="currentNetAPY"
              :after="netAPY"
              :details="projectedYieldDetails"
            />
            <SummaryRow label="Oracle price">
              <SummaryPriceValue
                :value="!priceFixed.isZero() ? formatSmartAmount(priceInvert.invertValue(priceFixed.toUnsafeFloat())) : undefined"
                :symbol="priceInvert.displaySymbol"
                invertible
                @invert="priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. price">
              <SummaryPriceValue
                :before="priceInvert.invertValue(currentLiquidationPrice) != null ? formatSmartAmount(priceInvert.invertValue(currentLiquidationPrice)!) : undefined"
                :after="priceInvert.invertValue(liquidationPrice) != null ? formatSmartAmount(priceInvert.invertValue(liquidationPrice)!) : undefined"
                :symbol="priceInvert.displaySymbol"
                invertible
                @invert="priceInvert.toggle"
              />
            </SummaryRow>
            <SummaryRow label="Liq. buffer">
              <SummaryValue
                :before="formatLiqBuffer(priceInvert.invertValue(priceFixed.toUnsafeFloat()), priceInvert.invertValue(currentLiquidationPrice))"
                :after="formatLiqBuffer(priceInvert.invertValue(priceFixed.toUnsafeFloat()), priceInvert.invertValue(liquidationPrice))"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="LTV">
              <SummaryValue
                :before="formatNumber(currentUserLTV)"
                :after="formatNumber(ltv)"
                suffix="%"
              />
            </SummaryRow>
            <SummaryRow label="Health score">
              <SummaryValue
                :before="currentHealth != null ? formatHealthScore(currentHealth) : undefined"
                :after="formatHealthScore(health)"
              />
            </SummaryRow>
          </VaultFormInfoBlock>

          <FormSubmitFooter
            :submit-disabled="reviewBorrowDisabled"
            :submit-loading="isSubmitting || isPreparing"
            :disabled-reason="disabledReasonInfo?.message"
            :disabled-reason-variant="disabledReasonInfo?.variant"
            :can-add-to-batch="canAddToBatch"
            @add-to-batch="addToBatch"
          >
            Review Borrow
          </FormSubmitFooter>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
