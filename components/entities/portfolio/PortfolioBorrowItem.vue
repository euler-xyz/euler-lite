<script setup lang="ts">
import { getRoe, getNetAPY } from '~/utils/vault/apy'
import {
  getSubAccountId as getSubAccountIndex,
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type SecuritizeCollateralVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { getAssetUsdValue, formatAssetValue, getCollateralUsdValue, toUsdAmount, type UsdAmount } from '~/utils/sdk-prices'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated, getVaultNotice, isVaultNoticeSpecific } from '~/utils/eulerLabelsUtils'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultNetApyModal, PortfolioRoeModal } from '#components'
import { useAccount } from '@wagmi/vue'
import { getAddress } from 'viem'
import { formatNumber, formatCompactUsdValue, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'

const { position } = defineProps<{ position: PortfolioBorrowPosition<VaultEntity> }>()
const { getVaultCategory, isVerifiedVault } = useVaultRegistry()

const { address } = useAccount()
const { portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const modal = useModal()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getEligibleLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, isLoopingEligible } = useRewardsApy()

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
const userLTVValue = computed(() => position.userLTV ?? position.currentLTV)
const liquidationLTV = computed(() => getBorrowPositionEffectiveLiquidationLTV(position))
const liquidationLTVPercent = computed(() =>
  liquidationLTV.value === undefined ? null : ltvToPercent(liquidationLTV.value),
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
const loopingRewardAPY = computed(() =>
  getEligibleLoopingRewardApy(borrowVault.value.address || '', collateralVault.value.address || '', actualMultiplier.value),
)
const loopingEligible = computed(() =>
  isLoopingEligible(borrowVault.value.address || '', collateralVault.value.address || '', actualMultiplier.value),
)
const hasRewards = computed(() =>
  hasSupplyRewards(collateralVault.value.address || '')
  || hasBorrowRewards(borrowVault.value.address || '', collateralVault.value.address || '')
  || loopingEligible.value,
)
const collateralSupplyApy = computed(() => {
  return withIntrinsicSupplyApy(
    getVaultSupplyApy(collateralVault.value),
    collateralVault.value?.asset.address,
  )
})
const borrowApy = computed(() => withIntrinsicBorrowApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value?.asset.address,
))

const collateralValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

const updateCollateralValue = async () => {
  // Collateral price ALWAYS comes from liability vault's oracle, converted to USD
  if (!collateralItems.value.length) {
    collateralValue.value = toUsdAmount(await getCollateralUsdValue(supplied.value, borrowVault.value, collateralVault.value, 'off-chain'))
    return
  }

  // For multiple collaterals, sum up using liability vault's oracle for each
  const promises = collateralItems.value.map(item =>
    getCollateralUsdValue(item.assets, borrowVault.value, item.vault, 'off-chain'),
  )
  const values = await Promise.all(promises)
  const allHavePrice = values.every(v => v !== undefined)
  collateralValue.value = {
    usd: values.reduce<number>((total, val) => total + (val ?? 0), 0),
    hasPrice: allHavePrice,
  }
}

watchEffect(() => {
  updateCollateralValue()
})

const collateralValueDisplay = computed(() => {
  return collateralValue.value.hasPrice
    ? formatCompactUsdValue(collateralValue.value.usd)
    : `${roundAndCompactTokens(collateralItems.value[0]?.assets ?? supplied.value, BigInt(collateralVault.value.shares.decimals))} ${collateralVault.value.asset.symbol}`
})

const borrowedValueInfo = ref<{ display: string, hasPrice: boolean }>({ display: '-', hasPrice: false })

const updateBorrowedValueInfo = async () => {
  const price = await formatAssetValue(borrowed.value, borrowVault.value, 'off-chain')
  borrowedValueInfo.value = {
    display: price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display,
    hasPrice: price.hasPrice,
  }
}

watchEffect(() => {
  updateBorrowedValueInfo()
})

const borrowedValueDisplay = computed(() => borrowedValueInfo.value.display)

const borrowedValue = ref<UsdAmount>({ usd: 0, hasPrice: false })

const updateBorrowedValue = async () => {
  borrowedValue.value = toUsdAmount(await getAssetUsdValue(borrowed.value, borrowVault.value, 'off-chain'))
}

watchEffect(() => {
  updateBorrowedValue()
})

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

const netAPY = computed(() => {
  return getNetAPY(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowedValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
    loopingRewardAPY.value || null,
  )
})

const roe = computed(() => {
  return getRoe(
    collateralValue.value.usd,
    collateralSupplyApy.value,
    borrowedValue.value.usd,
    borrowApy.value,
    supplyRewardAPY.value || null,
    borrowRewardAPY.value || null,
    loopingRewardAPY.value || null,
  )
})

const intrinsicSupplyApy = computed(() => getIntrinsicApy(collateralVault.value.asset.address))
const intrinsicBorrowApy = computed(() => getIntrinsicApy(borrowVault.value.asset.address))
const baseSupplyApy = computed(() => getVaultSupplyApy(collateralVault.value))
const baseBorrowApy = computed(() => getVaultBorrowApy(borrowVault.value))
const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(collateralVault.value.address))
const borrowCampaignsForModal = computed(() => getBorrowRewardCampaigns(borrowVault.value.address, collateralVault.value.address))
const loopingCampaignsForModal = computed(() => getLoopingRewardCampaigns(borrowVault.value.address, collateralVault.value.address))

const userLTV = computed(() =>
  userLTVValue.value === undefined ? null : ltvToPercent(nanoToValue(userLTVValue.value, 18)),
)
const actualMultiplier = computed(() => {
  const equity = collateralValue.value.usd - borrowedValue.value.usd
  if (equity <= 0) return 0
  return collateralValue.value.usd / equity
})

const onNetApyClick = () => {
  modal.open(VaultNetApyModal, {
    props: {
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
      netAPY: netAPY.value,
      supplyCampaigns: supplyCampaignsForModal.value,
      borrowCampaigns: borrowCampaignsForModal.value,
      loopingCampaigns: loopingCampaignsForModal.value,
    },
  })
}

const onRoeClick = () => {
  modal.open(PortfolioRoeModal, {
    props: {
      roe: roe.value,
      multiplier: Number.isFinite(actualMultiplier.value) ? actualMultiplier.value : 0,
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
    :data-collateral-address="position.collateral.address.toLowerCase()"
    :data-borrow-address="position.borrow.address.toLowerCase()"
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
              class="text-h5 text-content-primary truncate"
              data-id="data-point"
              :data-key="positionKey"
              data-field="asset-symbols"
              :data-value="pairSymbols"
            >
              {{ pairSymbols }}
            </div>
          </div>
          <div class="flex gap-16 items-start shrink-0">
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                Net APY
                <SvgIcon
                  class="!w-16 !h-16 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  @click.prevent="onNetApyClick"
                />
              </div>
              <div
                class="text-p2 flex items-center"
                data-id="data-point"
                :data-key="positionKey"
                data-field="net-apy"
                :data-value="Number.isFinite(netAPY) ? netAPY : null"
                :class="[netAPY >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                <SvgIcon
                  v-if="hasRewards"
                  class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                  name="sparks"
                  @click.prevent="onNetApyClick"
                />
                {{ Number.isFinite(netAPY) ? `${formatNumber(netAPY)}%` : '-' }}
              </div>
            </div>
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                ROE
                <SvgIcon
                  class="!w-16 !h-16 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  @click.prevent="onRoeClick"
                />
              </div>
              <div
                class="text-p2 flex items-center"
                data-id="data-point"
                :data-key="positionKey"
                data-field="roe"
                :data-value="Number.isFinite(roe) ? roe : null"
                :class="[roe >= 0 ? 'text-accent-600' : 'text-error-500']"
              >
                <SvgIcon
                  v-if="hasRewards"
                  class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                  name="sparks"
                  @click.prevent="onRoeClick"
                />
                {{ Number.isFinite(roe) ? `${formatNumber(roe)}%` : '-' }}
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
          <div class="flex justify-between gap-8 text-right">
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
          <div class="flex justify-between gap-8 text-right">
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
            :data-value="hasQueryFailure ? 'Unknown' : nanoToValue(position.health, 18)"
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
          <template v-if="hasQueryFailure || liquidationLTVPercent === null || userLTV === null">
            <span class="text-warning-500 text-p3">Unknown</span>
          </template>
          <template v-else>
            <div class="flex justify-between items-center gap-16">
              <UiProgress
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
                  :data-value="`${userLTV}/${liquidationLTVPercent}`"
                >
                  {{ formatNumber(userLTV, 2) }}/{{ liquidationLTVPercent }}%
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
