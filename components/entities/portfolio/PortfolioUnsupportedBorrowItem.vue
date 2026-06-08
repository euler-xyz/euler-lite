<script setup lang="ts">
import {
  getSubAccountId as getSubAccountIndex,
  type EVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { toUsdAmount } from '~/utils/sdk-prices'
import { formatCompactUsdValue, formatExactAmount, formatHealthScore, formatNumber, truncate } from '~/utils/string-utils'
import { ltvToPercent, nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { getBorrowPositionCollateralAddresses } from '~/utils/portfolioBorrowPosition'
import { getBorrowPositionEffectiveLiquidationLTV, getBorrowPositionUserLTVPercent } from '~/utils/ltv'

const { position } = defineProps<{ position: PortfolioBorrowPosition<VaultEntity> }>()

const { address } = useWagmi()
const { portfolio, portfolioAddress } = useEulerAccount()
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')
const subAccountIndex = computed(() => {
  if (!ownerAddress.value || !position.subAccount) return 0
  return getSubAccountIndex(getAddress(ownerAddress.value), getAddress(position.subAccount))
})

const borrowVault = computed(() => position.borrowVault as EVault | undefined)
const borrowAddress = computed(() => borrowVault.value?.address ?? position.borrow.vaultAddress)
const collateralAddresses = computed(() => {
  const positionAddresses = getBorrowPositionCollateralAddresses(position)
  if (positionAddresses.length) return positionAddresses
  return [...(portfolio.value?.account.getSubAccount(position.subAccount)?.enabledCollaterals ?? [])]
})
const primaryCollateralAddress = computed(() => collateralAddresses.value[0] ?? position.collateral?.vaultAddress ?? '')
const positionKey = computed(() =>
  `${position.subAccount.toLowerCase()}:${primaryCollateralAddress.value.toLowerCase() || 'external'}:${borrowAddress.value.toLowerCase()}`,
)

const borrowedValue = computed(() => toUsdAmount(position.borrow.borrowedValueUsd))
const borrowedValueDisplay = computed(() => {
  if (borrowedValue.value.hasPrice) return formatCompactUsdValue(borrowedValue.value.usd)
  if (!borrowVault.value) return position.borrowed.toString()
  return `${roundAndCompactTokens(position.borrowed, borrowVault.value.shares.decimals)} ${borrowVault.value.asset.symbol}`
})
const borrowedCompactDisplay = computed(() => {
  if (!borrowVault.value) return ''
  return `${roundAndCompactTokens(position.borrowed, borrowVault.value.shares.decimals)} ${borrowVault.value.asset.symbol}`
})

const borrowedExactDisplay = computed(() => {
  if (!borrowVault.value) return ''
  return formatExactAmount(position.borrowed, borrowVault.value.shares.decimals, borrowVault.value.asset.symbol)
})

const health = computed(() => position.healthFactor)
const hasQueryFailure = computed(() => position.borrow.liquidity === undefined)
const liquidationLTV = computed(() => getBorrowPositionEffectiveLiquidationLTV(position))
const liquidationLTVPercent = computed(() =>
  liquidationLTV.value === undefined ? null : ltvToPercent(liquidationLTV.value),
)
const liquidationLTVDisplay = computed(() =>
  liquidationLTVPercent.value === null ? '-' : `${liquidationLTVPercent.value}%`,
)
const userLTV = computed(() => getBorrowPositionUserLTVPercent(position) ?? null)
const userLTVDisplay = computed(() => {
  if (userLTV.value === null) return ''
  return Number.isFinite(userLTV.value) ? formatNumber(userLTV.value, 2) : '∞'
})

const collateralValue = computed(() => toUsdAmount(position.totalCollateralValueUsd))
const collateralValueDisplay = computed(() =>
  collateralValue.value.hasPrice ? formatCompactUsdValue(collateralValue.value.usd) : 'Unknown',
)

const borrowLabel = computed(() => borrowVault.value?.shares.name ?? truncate(borrowAddress.value))
const borrowSymbol = computed(() => borrowVault.value?.asset.symbol ?? truncate(borrowAddress.value))
const unknownCollateralAsset = computed(() => ({
  address: '',
  symbol: 'Unknown collateral',
}))
const avatarAssets = computed(() =>
  borrowVault.value?.asset ? [unknownCollateralAsset.value, borrowVault.value.asset] : unknownCollateralAsset.value,
)
const pairSymbols = computed(() => `Unknown collateral/${borrowSymbol.value}`)
</script>

<template>
  <div
    class="block no-underline bg-surface rounded-xl border border-line-subtle shadow-card"
    data-id="portfolio-list-item"
    data-list="borrow"
    data-state="unsupported-collateral"
    :data-key="positionKey"
    :data-sub-account="position.subAccount.toLowerCase()"
    :data-collateral-address="primaryCollateralAddress.toLowerCase()"
    :data-borrow-address="borrowAddress.toLowerCase()"
  >
    <div class="flex py-16 px-16 pb-12 border-b border-line-default">
      <div class="flex flex-col gap-12 items-start w-full">
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
            :asset="avatarAssets"
            size="40"
          />
          <div class="flex-grow min-w-0">
            <div
              class="text-content-tertiary text-p3 mb-4 flex items-center gap-4"
              data-id="data-point"
              :data-key="positionKey"
              data-field="name"
              :data-value="`Unknown collateral / ${borrowLabel}`"
            >
              <span>Unknown collateral</span>
              <span
                class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-error-100 text-error-500 text-p5"
                title="This position uses collateral that Lite cannot resolve as a supported vault."
              >
                <SvgIcon
                  name="warning"
                  class="!w-14 !h-14"
                />
                Unknown
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
              <div class="text-content-tertiary text-p3 mb-4">
                Net APY
              </div>
              <div
                class="text-content-primary text-p2"
                data-id="data-point"
                :data-key="positionKey"
                data-field="net-apy"
                :data-value="null"
              >
                -
              </div>
            </div>
            <div class="flex flex-col items-end">
              <div class="text-content-tertiary text-p3 mb-4">
                ROE
              </div>
              <div
                class="text-content-primary text-p2"
                data-id="data-point"
                :data-key="positionKey"
                data-field="roe"
                :data-value="null"
              >
                -
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex py-12 px-16 pb-16">
      <div class="flex flex-col gap-12 w-full">
        <UiAlert
          title="Unsupported external collateral"
          description="This borrow is real, but its collateral is not a supported Euler vault in Lite. This row is informational only; some pricing details and actions are unavailable."
          variant="warning"
          size="compact"
        />
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Borrow vault
          </div>
          <div
            class="text-content-primary text-p3 text-right"
            data-id="data-point"
            :data-key="positionKey"
            data-field="borrow-vault"
            :data-value="borrowAddress"
          >
            {{ borrowLabel }}
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
              v-if="borrowedValue.hasPrice && borrowedExactDisplay"
              class="text-content-tertiary text-p3"
              :exact="borrowedExactDisplay"
            >
              ~ {{ borrowedCompactDisplay }}
            </UiExactAmount>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Collateral value
          </div>
          <div
            class="text-content-primary text-p3 text-right"
            :class="{ 'text-warning-500': !collateralValue.hasPrice }"
            data-id="data-point"
            :data-key="positionKey"
            data-field="collateral-value"
            :data-value="collateralValueDisplay"
          >
            {{ collateralValueDisplay }}
          </div>
        </div>
        <div class="flex justify-between gap-16">
          <div class="text-content-tertiary text-p3 shrink-0">
            Collateral
          </div>
          <div
            class="flex flex-col gap-4 items-end min-w-0 text-right"
            data-id="data-point"
            :data-key="positionKey"
            data-field="collateral-addresses"
            :data-value="collateralAddresses.join(',')"
          >
            <span
              v-for="collateralAddress in collateralAddresses"
              :key="collateralAddress"
              class="text-content-primary text-p3 font-mono truncate max-w-full"
              :title="collateralAddress"
            >
              {{ truncate(collateralAddress) }}
            </span>
            <span
              v-if="collateralAddresses.length === 0"
              class="text-warning-500 text-p3"
            >
              Unknown
            </span>
          </div>
        </div>
        <div class="flex justify-between">
          <div class="text-content-tertiary text-p3">
            Health score
          </div>
          <span
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
              {{ formatHealthScore(nanoToValue(health, 18)) }}
            </template>
          </span>
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
  </div>
</template>
