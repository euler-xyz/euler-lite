<script setup lang="ts">
import {
  getSubAccountId as getSubAccountIndex,
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type SecuritizeCollateralVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { DateTime } from 'luxon'
import { getPositionRampStatus, getPositionRampTargetTimestamp } from '~/entities/account'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { toUsdAmount, type UsdAmount } from '~/utils/sdk-prices'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated, getVaultNotice, isVaultNoticeSpecific } from '~/utils/eulerLabelsUtils'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultNetApyModal, PortfolioRoeModal, VaultOverviewModal, UiModalPreviewTrigger } from '#components'
import { getAddress } from 'viem'
import { formatNumber, formatCompactUsdValue, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { withVaultIntrinsicApy, getVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { getBorrowPositionEffectiveLiquidationLTV, getBorrowPositionUserLTVPercent } from '~/utils/ltv'
import { areRoeCollateralVaultsCorrelatedWithBorrow } from '~/utils/position-roe'

const { position } = defineProps<{ position: PortfolioBorrowPosition<VaultEntity> }>()
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()

const { address } = useWagmi()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const modal = useModal()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getEligibleLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, isLoopingEligible } = useRewardsApy()
const { viewer, visibleBreakdown, visibleTotal } = useApyVisibility()
const { getTokenCategoryTags } = useTokenList()

const borrowVault = computed(() => position.borrowVault as EVault)
const collateralVault = computed(() => position.collateralVault as EVault | SecuritizeCollateralVault)
const collateralAddresses = computed(() => position.collateralVaults)
const primaryCollateralAddress = computed(() => collateralVault.value.address)
const borrowAddress = computed(() => borrowVault.value.address)
const positionKey = computed(() =>
  `${position.subAccount.toLowerCase()}:${primaryCollateralAddress.value.toLowerCase()}:${borrowAddress.value.toLowerCase()}`,
)
const supplied = computed(() => position.supplied)
const borrowed = computed(() => position.borrowed)
const health = computed(() => position.healthFactor)
const liquidationLTV = computed(() => getBorrowPositionEffectiveLiquidationLTV(position))
const liquidationLTVPercent = computed(() =>
  liquidationLTV.value === undefined ? null : ltvToPercent(liquidationLTV.value),
)
const liquidationLTVDisplay = computed(() =>
  liquidationLTVPercent.value === null ? '-' : `${liquidationLTVPercent.value}%`,
)

const { name: collateralProductName } = useEulerProductOfVault(primaryCollateralAddress)
const { name: borrowProductName } = useEulerProductOfVault(borrowAddress)

type PositionCollateral = {
  vault: EVault | SecuritizeCollateralVault
  assets: bigint
}

const collateralItems = computed<PositionCollateral[]>(() => {
  const items = position.collaterals.flatMap((collateralPosition) => {
    const vault = collateralPosition.vault
    if (!vault || (!isEVault(vault) && !isSecuritizeCollateralVault(vault))) return []

    return [{
      vault,
      assets: collateralPosition.assets,
    }]
  })

  return items.length
    ? items
    : [{ vault: collateralVault.value, assets: supplied.value }]
})

const hasQueryFailure = computed(() => position.borrow.liquidity === undefined)

const rampStatus = computed(() => getPositionRampStatus(position))
const rampTargetTimestamp = computed(() => getPositionRampTargetTimestamp(position))
const rampEndsRelative = computed(() => {
  const t = rampTargetTimestamp.value
  if (!rampStatus.value.isRamping || t === null) return ''
  return DateTime.fromSeconds(Number(t)).toRelative({ base: DateTime.now(), style: 'short' }) ?? ''
})
const forcedLiquidationRelative = computed(() => {
  const at = rampStatus.value.forcedLiquidationAt
  if (at === null) return ''
  return DateTime.fromSeconds(Number(at)).toRelative({ base: DateTime.now(), style: 'short' }) ?? ''
})

const utilisationWarning = computed(() => getUtilisationWarning(borrowVault.value, 'borrow'))
const hasMultipleCollaterals = computed(() => collateralAddresses.value.length > 1)
const collateralSymbolLabel = computed(() => {
  const symbol = collateralVault.value.asset.symbol
  return hasMultipleCollaterals.value ? `${symbol} & others` : symbol
})
const pairSymbols = computed(() => `${collateralSymbolLabel.value}/${borrowVault.value.asset.symbol}`)

const isGeoBlocked = computed(() => isAnyVaultBlockedByCountry(primaryCollateralAddress.value, borrowAddress.value))
const getSymbolForAddress = (addr: string): string => {
  if (normalizeAddress(addr) === normalizeAddress(borrowAddress.value)) {
    return borrowVault.value.asset.symbol
  }
  const item = collateralItems.value.find(c =>
    normalizeAddress(c.vault.address) === normalizeAddress(addr))
  return item?.vault.asset.symbol ?? collateralVault.value.asset.symbol
}
const prefixNotice = (notice: string, addr: string): string => {
  if (!isVaultNoticeSpecific(addr)) return notice
  return `${getSymbolForAddress(addr)} vault: ${notice}`
}
const collateralNotices = computed(() => {
  const addresses = collateralAddresses.value.length
    ? collateralAddresses.value
    : [primaryCollateralAddress.value]
  const seenRaw = new Set<string>()
  return addresses.reduce<string[]>((acc, addr) => {
    const raw = getVaultNotice(addr)
    if (!raw || seenRaw.has(raw)) return acc
    seenRaw.add(raw)
    acc.push(prefixNotice(raw, addr))
    return acc
  }, [])
})
const borrowNotice = computed(() => {
  const raw = getVaultNotice(borrowAddress.value)
  if (!raw) return ''
  // Dedup against raw collateral notices
  const addresses = collateralAddresses.value.length
    ? collateralAddresses.value
    : [primaryCollateralAddress.value]
  if (addresses.some(addr => getVaultNotice(addr) === raw)) return ''
  return prefixNotice(raw, borrowAddress.value)
})
const isAnyDeprecated = computed(() =>
  isVaultDeprecated(primaryCollateralAddress.value) || isVaultDeprecated(borrowAddress.value),
)

const isAnyUnverified = computed(() =>
  !isVerifiedVault(primaryCollateralAddress.value) || !isVerifiedVault(borrowAddress.value),
)

const collateralLabel = computed(() => {
  if (getVaultCategory(primaryCollateralAddress.value) === 'escrow') {
    return 'Escrowed collateral'
  }
  return collateralProductName || collateralVault.value.shares.name
})
const borrowLabel = computed(() => borrowProductName || borrowVault.value.shares.name)

const pairName = computed(() => {
  if (collateralLabel.value === borrowLabel.value) {
    return collateralLabel.value
  }
  return `${collateralLabel.value} / ${borrowLabel.value}`
})
const supplyRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value.address || ''))
const borrowRewardAPY = computed(() => getBorrowRewardApy(borrowVault.value.address || '', collateralVault.value.address || ''))
const actualMultiplier = computed(() => {
  const multiplier = position.multiplier
  return multiplier !== undefined && Number.isFinite(multiplier) ? multiplier : null
})
const rewardMultiplier = computed(() => actualMultiplier.value ?? 0)
const loopingRewardAPY = computed(() =>
  getEligibleLoopingRewardApy(borrowVault.value.address || '', collateralVault.value.address || '', rewardMultiplier.value),
)
const loopingEligible = computed(() =>
  isLoopingEligible(borrowVault.value.address || '', collateralVault.value.address || '', rewardMultiplier.value),
)
const hasRewards = computed(() =>
  hasSupplyRewards(collateralVault.value.address || '')
  || hasBorrowRewards(borrowVault.value.address || '', collateralVault.value.address || '')
  || loopingEligible.value,
)
const isRoeApplicable = computed(() => {
  const collaterals = collateralItems.value.map(item => item.vault)
  if (!collaterals.length || !borrowVault.value) return false
  if (collateralAddresses.value.length > collaterals.length) return false
  return areRoeCollateralVaultsCorrelatedWithBorrow(collaterals, borrowVault.value, getTokenCategoryTags)
})
const collateralSupplyApy = computed(() => {
  return withVaultIntrinsicApy(
    getVaultSupplyApy(collateralVault.value),
    collateralVault.value,
    enableIntrinsicApy.value,
  )
})
const borrowApy = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value,
  enableIntrinsicApy.value,
))

const collateralValue = computed<UsdAmount>(() => toUsdAmount(position.totalCollateralValueUsd))

const collateralValueDisplay = computed(() => {
  return collateralValue.value.hasPrice
    ? formatCompactUsdValue(collateralValue.value.usd)
    : `${roundAndCompactTokens(collateralItems.value[0]?.assets ?? supplied.value, BigInt(collateralVault.value.shares.decimals))} ${collateralVault.value.asset.symbol}`
})

const borrowedValue = computed<UsdAmount>(() => toUsdAmount(position.borrow.borrowedValueUsd))

const borrowedValueInfo = computed<{ display: string, hasPrice: boolean }>(() => {
  if (borrowedValue.value.hasPrice) {
    return {
      display: formatCompactUsdValue(borrowedValue.value.usd),
      hasPrice: true,
    }
  }
  return {
    display: `${roundAndCompactTokens(borrowed.value, borrowVault.value.shares.decimals)} ${borrowVault.value.asset.symbol}`,
    hasPrice: false,
  }
})

const borrowedValueDisplay = computed(() => borrowedValueInfo.value.display)

const netAssetValue = computed<UsdAmount>(() => {
  if (!collateralValue.value.hasPrice || !borrowedValue.value.hasPrice) {
    return { usd: 0, hasPrice: false }
  }
  return {
    usd: collateralValue.value.usd - borrowedValue.value.usd,
    hasPrice: true,
  }
})

const netAssetValueDisplay = computed(() => {
  return netAssetValue.value.hasPrice ? formatCompactUsdValue(netAssetValue.value.usd) : '-'
})

const apyBreakdown = computed(() => position.getApyBreakdown({ viewer: viewer.value }))
const roeBreakdown = computed(() => position.getRoeBreakdown({ viewer: viewer.value }))
const netApyBreakdown = computed(() => visibleBreakdown(apyBreakdown.value))
const visibleRoeBreakdown = computed(() => visibleBreakdown(roeBreakdown.value))
const netAPY = computed(() => visibleTotal(apyBreakdown.value))
const roe = computed(() => visibleTotal(roeBreakdown.value))

const intrinsicSupplyApy = computed(() => getVaultIntrinsicApy(collateralVault.value, enableIntrinsicApy.value))
const intrinsicBorrowApy = computed(() => getVaultIntrinsicApy(borrowVault.value, enableIntrinsicApy.value))
const baseSupplyApy = computed(() => getVaultSupplyApy(collateralVault.value))
const baseBorrowApy = computed(() => getVaultBorrowApy(borrowVault.value))
const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(collateralVault.value.address))
const borrowCampaignsForModal = computed(() => getBorrowRewardCampaigns(borrowVault.value.address, collateralVault.value.address))
const loopingCampaignsForModal = computed(() => getLoopingRewardCampaigns(borrowVault.value.address, collateralVault.value.address))

const userLTV = computed(() => getBorrowPositionUserLTVPercent(position) ?? null)
const userLTVDisplay = computed(() => {
  if (userLTV.value === null) return ''
  return Number.isFinite(userLTV.value) ? formatNumber(userLTV.value, 2) : '∞'
})
const actualMultiplierDisplay = computed(() =>
  actualMultiplier.value !== null ? `${formatNumber(actualMultiplier.value, 2, 2)}x` : '-',
)

const netApyModalData = computed(() => ({
  props: {
    apyBreakdown: netApyBreakdown.value,
    supplyUSD: collateralValue.value.usd,
    borrowUSD: borrowedValue.value.usd,
    baseSupplyAPY: baseSupplyApy.value,
    baseBorrowAPY: baseBorrowApy.value,
    intrinsicSupplyAPY: intrinsicSupplyApy.value,
    intrinsicBorrowAPY: intrinsicBorrowApy.value,
    supplyRewardAPY: supplyRewardAPY.value || null,
    borrowRewardAPY: borrowRewardAPY.value || null,
    loopingRewardAPY: loopingRewardAPY.value || null,
    loopingEligible: loopingEligible.value,
    netAPY: netAPY.value ?? 0,
    supplyCampaigns: supplyCampaignsForModal.value,
    borrowCampaigns: borrowCampaignsForModal.value,
    loopingCampaigns: loopingCampaignsForModal.value,
  },
}))

const roeModalData = computed(() => ({
  props: {
    roeBreakdown: visibleRoeBreakdown.value,
    roe: roe.value ?? 0,
    multiplier: actualMultiplier.value,
    supplyAPY: collateralSupplyApy.value,
    borrowAPY: borrowApy.value,
    supplyRewardAPY: supplyRewardAPY.value || null,
    borrowRewardAPY: borrowRewardAPY.value || null,
    loopingRewardAPY: loopingRewardAPY.value || null,
    loopingEligible: loopingEligible.value,
    userLTV: userLTV.value,
    supplyCampaigns: supplyCampaignsForModal.value,
    borrowCampaigns: borrowCampaignsForModal.value,
    loopingCampaigns: loopingCampaignsForModal.value,
  },
}))

const openPositionInformationModal = () => {
  modal.open(VaultOverviewModal, {
    props: {
      title: 'Position information',
      pair: position,
      collateralVaults: collateralItems.value.map(item => item.vault),
    },
  })
}
</script>

<template>
  <NuxtLink
    :to="{ path: `/position/${subAccountIndex}`, query: { network: $route.query.network } }"
    class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
    data-id="portfolio-list-item"
    data-list="borrow"
    :data-key="positionKey"
    :data-sub-account="position.subAccount.toLowerCase()"
    :data-collateral-address="primaryCollateralAddress.toLowerCase()"
    :data-borrow-address="borrowAddress.toLowerCase()"
    :data-correlated="isRoeApplicable"
  >
    <div class="flex py-16 px-16 pb-12 border-b border-line-default">
      <div
        class="flex flex-col gap-12 items-start w-full"
      >
        <div
          class="text-h6 text-content-secondary bg-surface-secondary py-4 px-12 rounded-8 border border-line-default"
          data-id="data-point"
          :data-key="positionKey"
          data-field="position-index"
          :data-value="subAccountIndex"
        >
          Position {{ subAccountIndex }}
        </div>
        <div class="flex gap-12 w-full">
          <AssetAvatar
            :asset="[collateralVault.asset, borrowVault.asset]"
            size="40"
          />
          <div class="flex-grow min-w-0">
            <div
              class="text-content-tertiary text-p3 mb-4 flex items-center gap-4"
              data-id="data-point"
              :data-key="positionKey"
              data-field="name"
              :data-value="pairName"
            >
              <VaultDisplayName
                :name="pairName"
                :is-unverified="isAnyUnverified"
              />
              <span
                v-if="isGeoBlocked"
                class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
                title="This vault is not available in your region"
              >
                <SvgIcon
                  name="warning"
                  class="!w-14 !h-14"
                />
                Restricted
              </span>
              <span
                v-if="isAnyDeprecated"
                class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-warning-100 text-warning-500 text-p5"
                title="One or more vaults in this position have been deprecated."
              >
                <SvgIcon
                  name="warning"
                  class="!w-14 !h-14"
                />
                Deprecated
              </span>
            </div>
            <div
              class="text-h5 text-content-primary flex items-center gap-8 min-w-0"
              data-id="data-point"
              :data-key="positionKey"
              data-field="asset-symbols"
              :data-value="pairSymbols"
            >
              <span class="truncate">{{ pairSymbols }}</span>
              <span class="inline-flex items-center gap-4">
                <CorrelatedPairBadge
                  v-if="isRoeApplicable"
                  compact
                  title="Correlated position."
                />
                <CorrelatedPairBadge
                  v-if="isRoeApplicable && actualMultiplierDisplay !== '-'"
                  compact
                  :label="actualMultiplierDisplay"
                  title="Effective multiplier at your LTV."
                />
              </span>
            </div>
          </div>
          <div class="flex gap-16 items-start shrink-0">
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                Net APY
                <UiModalPreviewTrigger
                  :component="VaultNetApyModal"
                  :modal-data="netApyModalData"
                  aria-label="Show net APY breakdown"
                >
                  <SvgIcon
                    class="!w-16 !h-16 text-content-muted hover:text-content-secondary cursor-pointer"
                    name="info-circle"
                    data-modal-trigger="net-apy"
                  />
                </UiModalPreviewTrigger>
              </div>
              <div
                class="text-p2 flex items-center"
                data-id="data-point"
                :data-key="positionKey"
                data-field="net-apy"
                :data-value="netAPY !== undefined && Number.isFinite(netAPY) ? netAPY : null"
                :class="[(netAPY ?? 0) >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                <UiModalPreviewTrigger
                  v-if="hasRewards"
                  :component="VaultNetApyModal"
                  :modal-data="netApyModalData"
                  aria-label="Show net APY rewards breakdown"
                >
                  <SvgIcon
                    class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                    name="sparks"
                    data-modal-trigger="net-apy"
                  />
                </UiModalPreviewTrigger>
                {{ netAPY !== undefined && Number.isFinite(netAPY) ? `${formatNumber(netAPY)}%` : '-' }}
              </div>
            </div>
            <div
              v-if="isRoeApplicable"
              class="flex flex-col items-end"
            >
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                ROE
                <UiModalPreviewTrigger
                  :component="PortfolioRoeModal"
                  :modal-data="roeModalData"
                  aria-label="Show ROE breakdown"
                >
                  <SvgIcon
                    class="!w-16 !h-16 text-content-muted hover:text-content-secondary cursor-pointer"
                    name="info-circle"
                    data-modal-trigger="roe"
                  />
                </UiModalPreviewTrigger>
              </div>
              <div
                class="text-p2 flex items-center"
                data-id="data-point"
                :data-key="positionKey"
                data-field="roe"
                :data-value="roe !== undefined && Number.isFinite(roe) ? roe : null"
                :class="[(roe ?? 0) >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                <UiModalPreviewTrigger
                  v-if="hasRewards"
                  :component="PortfolioRoeModal"
                  :modal-data="roeModalData"
                  aria-label="Show ROE rewards breakdown"
                >
                  <SvgIcon
                    class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                    name="sparks"
                    data-modal-trigger="roe"
                  />
                </UiModalPreviewTrigger>
                {{ roe !== undefined && Number.isFinite(roe) ? `${formatNumber(roe)}%` : '-' }}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
    <div class="flex py-12 px-16 pb-16">
      <div
        class="flex flex-col gap-12 w-full"
      >
        <PortfolioNotice
          v-for="(notice, i) in collateralNotices"
          :key="'c' + i"
          :notice="notice"
        />
        <PortfolioNotice :notice="borrowNotice" />
        <VaultWarningBanner :warnings="[utilisationWarning]" />
        <div
          v-if="hasQueryFailure"
          class="flex items-center gap-6 text-warning-500 text-p4"
        >
          <UiIcon
            name="info-circle"
            class="!w-14 !h-14 shrink-0"
          />
          Oracle pricing unavailable. Some details may be missing.
        </div>
        <UiAlert
          v-if="rampStatus.isRamping && rampStatus.willBeLiquidated && !hasQueryFailure"
          title="Liquidation LTV ramping down"
          :description="`Your position is projected to become liquidatable ${forcedLiquidationRelative || 'before the ramp ends'} — consider closing or reducing debt.`"
          variant="error"
          size="compact"
        />
        <UiAlert
          v-else-if="rampStatus.isRamping && hasQueryFailure"
          title="Liquidation LTV ramping down"
          :description="`Ends ${rampEndsRelative}. Oracle pricing is currently unavailable, so we can't tell whether your position will remain safe.`"
          variant="warning"
          size="compact"
        />
        <UiAlert
          v-else-if="rampStatus.isRamping"
          title="Liquidation LTV ramping down"
          :description="`Ends ${rampEndsRelative}. Your position is currently safe at the post-ramp threshold.`"
          variant="warning"
          size="compact"
        />
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Net asset value
          </div>
          <div class="flex justify-between gap-8 text-right">
            <div
              class="text-content-primary text-p3"
              data-id="data-point"
              :data-key="positionKey"
              data-field="net-asset-value"
              :data-value="netAssetValueDisplay"
            >
              {{ netAssetValueDisplay }}
            </div>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            My Debt
          </div>
          <div
            class="flex justify-between gap-8 text-right cursor-pointer"
            data-id="position-information-trigger"
            data-modal-trigger="position-information"
            data-position-section="borrow"
            @click.prevent.stop="openPositionInformationModal"
          >
            <div
              class="text-content-primary text-p3"
              data-id="data-point"
              :data-key="positionKey"
              data-field="debt-value"
              :data-value="borrowedValueDisplay"
            >
              {{ borrowedValueDisplay }}
            </div>
            <UiExactAmount
              v-if="borrowedValueInfo.hasPrice"
              class="text-content-tertiary text-p3"
              :exact="formatExactAmount(borrowed, borrowVault.shares.decimals, borrowVault.asset.symbol)"
            >
              ~ {{ roundAndCompactTokens(borrowed, borrowVault.shares.decimals) }}
              {{ borrowVault.asset.symbol }}
            </UiExactAmount>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Collateral value
          </div>
          <div
            class="flex justify-between gap-8 text-right cursor-pointer"
            data-id="position-information-trigger"
            data-modal-trigger="position-information"
            data-position-section="collateral"
            @click.prevent.stop="openPositionInformationModal"
          >
            <div
              class="text-content-primary text-p3"
              data-id="data-point"
              :data-key="positionKey"
              data-field="collateral-value"
              :data-value="collateralValueDisplay"
            >
              <template v-if="collateralValue.hasPrice">
                {{ collateralValueDisplay }}
              </template>
              <UiExactAmount
                v-else
                :exact="formatExactAmount(collateralItems[0]?.assets ?? supplied, collateralVault.shares.decimals, collateralVault.asset.symbol)"
              >
                {{ collateralValueDisplay }}
              </UiExactAmount>
            </div>
            <UiExactAmount
              v-if="collateralValue.hasPrice"
              class="text-content-tertiary text-p3"
              :exact="formatExactAmount(collateralItems[0]?.assets ?? supplied, collateralVault.shares.decimals, collateralVault.asset.symbol)"
            >
              ~ {{ roundAndCompactTokens(collateralItems[0]?.assets ?? supplied, collateralVault.shares.decimals) }}
              {{ collateralVault.asset.symbol }} {{ collateralItems.length > 1 ? '& others' : '' }}
            </UiExactAmount>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Health score
          </div>
          <div
            class="text-content-primary text-p3"
            data-id="data-point"
            :data-key="positionKey"
            data-field="health-score"
            :data-value="hasQueryFailure || health === undefined ? 'Unknown' : nanoToValue(health, 18)"
          >
            <span
              v-if="hasQueryFailure || health === undefined"
              class="text-warning-500"
            >Unknown</span>
            <template v-else>
              {{ formatNumber(nanoToValue(health, 18)) }}
            </template>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Your LTV
          </div>
          <template v-if="hasQueryFailure || userLTV === null">
            <span class="text-warning-500 text-p3">Unknown</span>
          </template>
          <template v-else>
            <div class="flex justify-between items-center gap-16">
              <UiProgress
                v-if="liquidationLTVPercent !== null"
                style="width: 111px"
                :model-value="userLTV"
                :max="liquidationLTVPercent"
                :color="userLTV >= (liquidationLTVPercent - 2) ? 'danger' : undefined"
                size="small"
              />
              <div class="flex justify-between gap-8 text-right">
                <div
                  class="text-content-primary text-p3"
                  data-id="data-point"
                  :data-key="positionKey"
                  data-field="ltv"
                  :data-value="`${userLTV}/${liquidationLTVPercent ?? '-'}`"
                >
                  {{ userLTVDisplay }}/{{ liquidationLTVDisplay }}
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
