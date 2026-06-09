<script setup lang="ts">
import { getNetAPY, getProjectedRates } from '~/utils/vault/apy'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import type { VaultAsset } from '~/types/asset'
import { getHookDisabledWarning, getUtilisationWarning, getBorrowCapWarning } from '~/composables/useVaultWarnings'
import { isOpDisabled, OP_BORROW } from '~/utils/vault-hooks'
import { getAssetUsdValueOrZero, getAssetOraclePrice, getCollateralOraclePrice, conservativePriceRatio } from '~/utils/sdk-prices'
import { getTotalCollateralValue } from '~/utils/position-estimates'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { isAnyVaultBlockedByCountry, isVaultRestrictedByCountry } from '~/composables/useGeoBlock'
import type { PortfolioBorrowPosition, VaultEntity, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { formatNumber, formatSmartAmount, formatHealthScore, trimTrailingZeros } from '~/utils/string-utils'
import { formatLiquidationBuffer as formatLiqBuffer } from '~/utils/repayUtils'
import { ltvToPercent, nanoToValue } from '~/utils/crypto-utils'
import { isOperationBlocked } from '~/utils/operationGuardRegistry'
import { createRaceGuard } from '~/utils/race-guard'
import type { DisabledReasonInfo } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import type { BorrowVaultPair } from '~/types/borrow-pair'
import { OperationReviewModal } from '#components'
import { FixedPoint } from '~/utils/fixed-point'

const router = useRouter()
const _route = useRoute()
const modal = useModal()
const { error } = useToast()
const { planBorrow, executePlan } = useEulerTx()
const { addEntry: addBatchEntry } = useTxBatch()
const { redirectAfterAdd } = useBatchRedirect()
const { account: planAccount } = usePlanAccount()
const { getBorrowVaultPair } = useVaults()
const { isConnected, address } = useWagmi()
const { isSpyMode } = useSpyMode()
const { isPositionsLoading, isPositionsLoaded, getPositionBySubAccountIndex } = useEulerAccount()
const positionIndex = usePositionIndex()
const { getBalance } = useWallets()
const { runSimulation, simulationError, clearSimulationError } = useTransactionPlanSimulation()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()
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
// Layer-aware: tracks the active batch layer's portfolio so the form reflects
// simulated debt/collateral (a one-shot ref would freeze at the real state).
const position = computed<PortfolioBorrowPosition<VaultEntity> | undefined>(() =>
  (!isConnected.value && !isSpyMode.value) ? undefined : getPositionBySubAccountIndex(+positionIndex),
)
const userLTV = ref(0)
const currentNetAPY = ref<number>()
const currentHealth = ref<number>()
const currentLiquidationPrice = ref<number>()
const currentUserLTV = ref(0)

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
  if (!isConnected.value) return false
  if (pair.value?.borrow && isOpDisabled(pair.value.borrow, OP_BORROW)) return true

  const currentSupplied = position.value?.supplied || 0n
  const newCollateralAmount = valueToNano(collateralAmount.value, collateralVault.value?.asset?.decimals)
  const additionalCollateralNeeded = newCollateralAmount > currentSupplied
    ? newCollateralAmount - currentSupplied
    : 0n

  return (additionalCollateralNeeded > 0n && balance.value < additionalCollateralNeeded)
    || isLoading.value || !(+collateralAmount.value)
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
  if (errorText.value) return { message: errorText.value, variant: 'error' }
  if (simulationError.value) return { message: simulationError.value, variant: 'error' }
  return undefined
})
const borrowVault = computed(() => pair.value?.borrow)
const collateralVault = computed(() => pair.value?.collateral)
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
const borrowAmountFixed = computed(() => FixedPoint.fromValue(
  valueToNano(borrowAmount.value || '0', borrowVault.value?.asset.decimals),
  Number(borrowVault.value?.asset.decimals),
))
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

const collateralSupplyRewardApy = computed(() => getSupplyRewardApy(collateralVault.value?.address || ''))
const borrowRewardApy = computed(() => getBorrowRewardApy(borrowVault.value?.address || '', collateralVault.value?.address || ''))
const collateralSupplyApy = computed(() => withVaultIntrinsicApy(
  getVaultSupplyApy(collateralVault.value),
  collateralVault.value,
  enableIntrinsicApy.value,
))
const borrowApy = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value,
  enableIntrinsicApy.value,
))

const load = async () => {
  if (!isConnected.value && !isSpyMode.value) {
    return
  }
  isLoading.value = true
  // `position` is a layer-aware computed; load() only seeds the one-shot
  // "before" baseline (current LTV/health/APY) off the initial real state.
  if (!position.value) {
    isLoading.value = false
    return
  }
  const collateralAddress = position.value.collateralVault?.address
  const borrowAddress = position.value.borrowVault?.address
  if (!collateralAddress || !borrowAddress) {
    isLoading.value = false
    return
  }
  const positionLtv = position.value.userLTV ?? position.value.currentLTV
  if (positionLtv === undefined) {
    isLoading.value = false
    return
  }
  userLTV.value = Number(formatNumber(ltvToPercent(nanoToValue(positionLtv, 18))))
  currentUserLTV.value = userLTV.value
  ltv.value = userLTV.value
  try {
    pair.value = await getBorrowVaultPair(collateralAddress as string, borrowAddress as string) as BorrowVaultPair
    // Set collateral amount from existing position supply so LTV slider and borrow input work
    const suppliedFixed = FixedPoint.fromValue(
      position.value!.supplied,
      Number(collateralVault.value!.asset.decimals),
    )
    collateralAmount.value = trimTrailingZeros(suppliedFixed.toString())
    // Fetch fresh underlying asset balance for this specific vault
    await updateBalance()
    // Compute current position values for before→after display
    const currentLtvPercent = ltvToPercent(nanoToValue(positionLtv, 18))
    currentHealth.value = currentLtvPercent <= 0
      ? Infinity
      : ltvToPercent(pair.value!.ltv.liquidationLTV) / currentLtvPercent
    currentLiquidationPrice.value = currentHealth.value < 0.1 ? Infinity : priceFixed.value.toUnsafeFloat() / currentHealth.value
    const [collUsd, borUsd] = await Promise.all([
      getAssetUsdValueOrZero(position.value!.supplied || 0, collateralVault.value!, 'off-chain'),
      getAssetUsdValueOrZero(position.value!.borrowed || 0, borrowVault.value!, 'off-chain'),
    ])
    currentNetAPY.value = getNetAPY(
      collUsd,
      collateralSupplyApy.value,
      borUsd,
      borrowApy.value,
      collateralSupplyRewardApy.value || null,
      borrowRewardApy.value || null,
    )
  }
  catch (e) {
    showError('Unable to load Vault')
    console.warn(e)
  }
  finally {
    isLoading.value = false
  }
}
// `balance` is now a reactive computed over the wallet entity; this just clears
// the initial loading flag.
const updateBalance = () => {
  isBalanceLoading.value = false
}
const submit = async () => {
  if (isOperationBlocked.value) return
  if (isPreparing.value || isGeoBlocked.value || isBorrowRestricted.value) return
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
        onConfirm: async () => {
          await send()
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
const addToBatch = () => {
  if (!borrowVault.value || !position.value || !(+borrowAmount.value)) return
  const vaultAddress = borrowVault.value.address as Address
  const amount = valueToNano(borrowAmount.value, borrowVault.value.shares.decimals)
  const borrowAccount = position.value.subAccount as Address
  const label = `Borrow ${borrowAmount.value} ${borrowVault.value.asset.symbol}`
  addBatchEntry({
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
  redirectAfterAdd('/portfolio')
}

const send = async () => {
  try {
    isSubmitting.value = true
    if (!collateralVault.value || !borrowVault.value || !position.value) {
      return
    }
    const txPlan = await planBorrow({
      vaultAddress: borrowVault.value.address as Address,
      amount: borrowAmountFixed.value.toFormat({ decimals: Number(borrowVault.value.shares.decimals) }).value,
      borrowAccount: position.value.subAccount as Address,
      account: planAccount.value,
    })
    await executePlan(txPlan)

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

watch(computedBorrowAmount, (val) => {
  if (isLtvDriven.value && val !== null) {
    borrowAmount.value = val
  }
})

const onBorrowInput = async () => {
  isLtvDriven.value = false
  await nextTick()
  if (!position.value) return
  const totalCollateral = getTotalCollateralValue(position.value)
  if (!totalCollateral || totalCollateral <= 0) return
  const totalBorrow = nanoToValue(position.value.borrowed, borrowVault.value?.shares.decimals || 18) + (+borrowAmount.value || 0)
  ltv.value = +((totalBorrow / totalCollateral) * 100).toFixed(2)
}
const onLtvInput = () => {
  isLtvDriven.value = true
}
const updateSyncEstimates = () => {
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

const asyncEstimatesGuard = createRaceGuard()
const updateAsyncEstimates = useDebounceFn(async () => {
  if (!pair.value || !borrowVault.value || !collateralVault.value) return
  const gen = asyncEstimatesGuard.next()
  try {
    const additionalBorrowNano = valueToNano(borrowAmount.value || '0', borrowVault.value.shares.decimals)
    const existingBorrow = nanoToValue(position.value?.borrowed || 0n, borrowVault.value.shares.decimals)
    const totalBorrow = existingBorrow + (+borrowAmount.value || 0)

    const [borrowProjected, collateralUsd, borrowUsd] = await Promise.all([
      getProjectedRates(
        borrowVault.value.address,
        borrowVault.value.totalCash,
        borrowVault.value.totalBorrowed,
        -additionalBorrowNano,
        additionalBorrowNano,
      ),
      getAssetUsdValueOrZero(+collateralAmount.value || 0, collateralVault.value!, 'off-chain'),
      getAssetUsdValueOrZero(totalBorrow, borrowVault.value!, 'off-chain'),
    ])

    if (asyncEstimatesGuard.isStale(gen)) return

    const projectedBorrowApy = borrowProjected
      ? borrowApy.value + (nanoToValue(borrowProjected.borrowAPY, 25) - getVaultBorrowApy(borrowVault.value))
      : borrowApy.value

    netAPY.value = getNetAPY(
      collateralUsd,
      collateralSupplyApy.value,
      borrowUsd,
      projectedBorrowApy,
      collateralSupplyRewardApy.value || null,
      borrowRewardApy.value || null,
    )
  }
  catch (e) {
    if (asyncEstimatesGuard.isStale(gen)) return
    logWarn('borrow-more/asyncEstimates', e)
    netAPY.value = undefined
  }
  finally {
    if (!asyncEstimatesGuard.isStale(gen)) {
      isEstimatesLoading.value = false
    }
  }
}, 500)

watch(isPositionsLoaded, (val) => {
  if (val) {
    load()
  }
}, { immediate: true })
watch(isConnected, () => {
  updateBalance()
})
watch(address, () => {
  updateBalance()
})
watch([collateralAmount, borrowAmount], async () => {
  clearSimulationError()
  if (!pair.value) {
    return
  }
  updateSyncEstimates()
  if (!isEstimatesLoading.value) {
    isEstimatesLoading.value = true
  }
  updateAsyncEstimates()
})
</script>

<template>
  <div class="relative">
    <BackButton
      class="hidden tablet:inline-flex tablet:absolute tablet:top-20 tablet:right-full tablet:mr-4"
      :fallback="`/position/${positionIndex}`"
    />
    <VaultForm
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
            <SummaryRow label="Net APY">
              <SummaryValue
                :before="currentNetAPY != null ? formatNumber(currentNetAPY) : undefined"
                :after="netAPY != null ? formatNumber(netAPY) : undefined"
                suffix="%"
              />
            </SummaryRow>
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

          <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
            <VaultFormSubmit
              :disabled="reviewBorrowDisabled"
              :loading="isSubmitting || isPreparing"
              :disabled-reason="disabledReasonInfo?.message"
              :disabled-reason-variant="disabledReasonInfo?.variant"
              :can-add-to-batch="!!(+borrowAmount)"
              @add-to-batch="addToBatch"
            >
              Review Borrow
            </VaultFormSubmit>
          </div>
        </div>
      </template>
    </VaultForm>
  </div>
</template>
