<script setup lang="ts">
import type { MarketGroup } from '~/entities/lend-discovery'
import { formatCompactUsdValue, formatNumber, stringToColor } from '~/utils/string-utils'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import {
  getMarketEntities,
  getDeprecatedVaultCount,
  getUnknownCollateralCount,
  getMiniDiagram,
  getBorrowableVaults,
  findVault,
  type BestMaxRoeResult,
} from '~/utils/discoveryCalculations'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { VaultMaxRoeModal, UiModalPreviewTrigger } from '#components'

const props = defineProps<{
  market: MarketGroup
  isExpanded: boolean
}>()

defineEmits<{
  toggle: []
}>()

const { withIntrinsicSupplyApy, withIntrinsicBorrowApy } = useIntrinsicApy()
const { getBorrowRewardApy, getSupplyRewardApy, getLoopingRewardApy } = useRewardsApy()
const { products } = useEulerLabels()

const isGovernanceLimited = computed(() =>
  props.market.source === 'product' && !!products[props.market.id]?.isGovernanceLimited,
)

const getProductDescription = (market: MarketGroup): string => {
  if (market.source !== 'product') return ''
  return products[market.id]?.description ?? ''
}

const getBestMaxRoe = (market: MarketGroup): BestMaxRoeResult => {
  const borrowable = getBorrowableVaults(market)
  let best = -Infinity
  let bestHasRewards = false
  let bestPair = ''
  let bestMultiplier = 1
  let bestSupplyAPY = 0
  let bestBorrowAPY = 0
  let bestBorrowLTV = 0
  let bestBorrowVaultAddress = ''
  let bestCollateralAddress = ''

  for (const liability of borrowable) {
    const borrowBase = getVaultBorrowApy(liability)
    const borrowApy = withIntrinsicBorrowApy(borrowBase, liability.asset.address)

    for (const ltv of liability.collaterals) {
      if (ltv.borrowLTV === 0) continue
      const collateral = findVault(market, ltv.address)
      if (!collateral) continue

      const supplyBase = getVaultSupplyApy(collateral)
      const supplyApy = withIntrinsicSupplyApy(supplyBase, collateral.asset.address)
      const supplyRewards = getSupplyRewardApy(collateral.address)
      const borrowRewards = getBorrowRewardApy(liability.address, collateral.address)
      const loopingRewards = getLoopingRewardApy(liability.address, collateral.address)

      const supplyFinal = supplyApy + supplyRewards
      const borrowFinal = borrowApy - borrowRewards
      const multiplier = getMaxMultiplier(ltv.borrowLTV)
      const roe = getMaxRoe(multiplier, supplyFinal, borrowFinal, loopingRewards)

      if (roe > best) {
        best = roe
        bestHasRewards = supplyRewards > 0 || borrowRewards > 0 || loopingRewards > 0
        bestPair = `${collateral.asset.symbol}/${liability.asset.symbol}`
        bestMultiplier = multiplier
        bestSupplyAPY = supplyFinal
        bestBorrowAPY = borrowFinal
        bestBorrowLTV = ltvToPercent(ltv.borrowLTV)
        bestBorrowVaultAddress = liability.address
        bestCollateralAddress = collateral.address
      }
    }
  }

  const value = Number.isFinite(best) && best > -Infinity ? best : 0
  return {
    value,
    hasRewards: bestHasRewards,
    pair: bestPair,
    maxMultiplier: bestMultiplier,
    supplyAPY: bestSupplyAPY,
    borrowAPY: bestBorrowAPY,
    borrowLTV: bestBorrowLTV,
    borrowVaultAddress: bestBorrowVaultAddress,
    collateralAddress: bestCollateralAddress,
  }
}

const getMaxRoeModalData = (result: BestMaxRoeResult) => ({
  props: {
    maxRoe: result.value,
    maxMultiplier: result.maxMultiplier,
    supplyAPY: result.supplyAPY,
    borrowAPY: result.borrowAPY,
    borrowLTV: result.borrowLTV,
    borrowVaultAddress: result.borrowVaultAddress,
    collateralAddress: result.collateralAddress,
    isBestInMarket: true,
  },
})
</script>

<template>
  <button
    class="w-full text-left cursor-pointer p-16"
    data-id="discovery-market-card"
    :data-key="market.id"
    :data-market-id="market.id"
    :data-expanded="isExpanded"
    @click="$emit('toggle')"
  >
    <div class="flex items-center pb-12 border-b border-line-subtle">
      <template
        v-for="(marketEntities, entitiesIdx) in [getMarketEntities(market)]"
        :key="'entities-' + entitiesIdx"
      >
        <BaseAvatar
          v-if="marketEntities.logos.length > 0"
          class="icon--40 shrink-0"
          :class="{ 'opacity-20': isGovernanceLimited }"
          :src="marketEntities.logos"
          :label="marketEntities.name"
        />
        <div
          class="flex-grow min-w-0"
          :class="marketEntities.logos.length > 0 ? 'ml-12' : ''"
        >
          <div
            class="text-content-tertiary text-p3 mb-4 flex items-center gap-8"
            data-id="data-point"
            :data-key="market.id"
            data-field="market-entity"
            :data-value="marketEntities.name || market.curator?.name || 'Ungrouped'"
          >
            <span
              v-if="marketEntities.name"
              :class="{ 'opacity-20': isGovernanceLimited }"
            >{{ marketEntities.name }}</span>
            <template v-else-if="market.curator">
              {{ market.curator.name }}
            </template>
            <template v-else>
              Ungrouped
            </template>
            <span
              v-if="market.metrics.hasRecentlyAdded"
              class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
              title="Recently added vault"
            >
              <SvgIcon
                name="star"
                class="!w-14 !h-14"
              />
              Recently added
            </span>
            <GovernanceLimitedBadge v-if="isGovernanceLimited" />
          </div>
          <div
            class="text-h5 text-content-primary"
            data-id="data-point"
            :data-key="market.id"
            data-field="market-name"
            :data-value="market.name"
          >
            {{ market.name }}
          </div>
          <div
            v-if="getProductDescription(market)"
            class="text-p3 text-content-tertiary mt-4"
            data-id="data-point"
            :data-key="market.id"
            data-field="market-description"
            :data-value="getProductDescription(market)"
            :class="isExpanded ? '' : 'line-clamp-1'"
          >
            {{ getProductDescription(market) }}
          </div>
        </div>
      </template>
      <template
        v-for="(diagram, diagramIdx) in [getMiniDiagram(market)]"
        :key="'counts-' + diagramIdx"
      >
        <div class="flex flex-col items-end shrink-0 ml-12 text-content-tertiary text-p3">
          <span
            data-id="data-point"
            :data-key="market.id"
            data-field="asset-count"
            :data-value="diagram.assetCount"
          >{{ diagram.assetCount }} assets</span>
          <span
            class="text-content-muted"
            data-id="data-point"
            :data-key="market.id"
            data-field="pair-count"
            :data-value="diagram.pairCount"
          >{{ diagram.pairCount }} pairs</span>
          <span
            v-if="getDeprecatedVaultCount(market) > 0"
            class="text-warning-500 text-p5 mt-4"
          >
            {{ getDeprecatedVaultCount(market) }} deprecated
          </span>
          <span
            v-if="getUnknownCollateralCount(market) > 0"
            class="text-error-500 text-p5 mt-4"
            title="Collateral vaults whose risk manager isn't part of any declared product entity (or whose vault isn't loaded into the registry)."
          >
            {{ getUnknownCollateralCount(market) }} unknown
          </span>
        </div>
      </template>
    </div>

    <div class="flex pt-12 items-center mobile:justify-between mobile:border-b mobile:border-line-subtle mobile:pb-12">
      <div class="flex-1 flex gap-12 mobile:hidden">
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Total supply
          </div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="market.id"
            data-field="total-supply"
            :data-value="market.metrics.totalTVL"
          >
            {{ formatCompactUsdValue(market.metrics.totalTVL) }}
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Total borrowed
          </div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="market.id"
            data-field="total-borrowed"
            :data-value="market.metrics.totalBorrowed"
          >
            {{ formatCompactUsdValue(market.metrics.totalBorrowed) }}
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Available liquidity
          </div>
          <div
            class="text-p2 text-content-primary"
            data-id="data-point"
            :data-key="market.id"
            data-field="available-liquidity"
            :data-value="market.metrics.totalAvailableLiquidity"
          >
            {{ formatCompactUsdValue(market.metrics.totalAvailableLiquidity) }}
          </div>
        </div>
        <template
          v-for="(bestRoe, bestRoeIdx) in [getBestMaxRoe(market)]"
          :key="'max-roe-' + bestRoeIdx"
        >
          <div class="flex-1 min-w-0">
            <template v-if="bestRoe.value > 0">
              <UiModalPreviewTrigger
                :component="VaultMaxRoeModal"
                :modal-data="() => getMaxRoeModalData(bestRoe)"
                aria-label="Max ROE details"
              >
                <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                  Max ROE
                  <SvgIcon
                    class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors"
                    name="info-circle"
                  />
                </div>
                <div
                  class="text-p2 text-content-primary flex items-center gap-4 min-w-0"
                  data-id="data-point"
                  :data-key="market.id"
                  data-field="best-max-roe"
                  :data-value="bestRoe.value"
                >
                  <SvgIcon
                    v-if="bestRoe.hasRewards"
                    name="sparks"
                    class="!w-20 !h-20 text-accent-500 shrink-0 hover:text-accent-400 transition-colors"
                  />
                  <span class="shrink-0">{{ formatNumber(bestRoe.value, 2, 2) }}%</span>
                  <span
                    v-if="bestRoe.pair"
                    class="text-p4 text-content-muted min-w-0"
                    :class="isExpanded ? '' : 'truncate'"
                  >{{ bestRoe.pair }}</span>
                </div>
              </UiModalPreviewTrigger>
            </template>
          </div>
        </template>
      </div>

      <!-- Mobile: 2-column row matching lend card style -->
      <div class="hidden mobile:flex mobile:flex-1 mobile:justify-between">
        <div>
          <div class="text-content-tertiary text-p3 mb-4">
            Total supply
          </div>
          <div class="text-p2 text-content-primary">
            {{ formatCompactUsdValue(market.metrics.totalTVL) }}
          </div>
        </div>
        <div class="text-right">
          <div class="text-content-tertiary text-p3 mb-4">
            Available liquidity
          </div>
          <div class="text-p2 text-content-primary">
            {{ formatCompactUsdValue(market.metrics.totalAvailableLiquidity) }}
          </div>
        </div>
      </div>

      <!-- Mini topology graph (non-clickable preview) -->
      <template
        v-for="(diagram, graphIdx) in [getMiniDiagram(market)]"
        :key="'graph-' + graphIdx"
      >
        <div
          v-if="diagram.nodes.length > 1"
          class="shrink-0 w-[180px] h-[60px] hidden sm:flex items-center justify-end"
        >
          <svg
            class="h-[60px]"
            :style="{ width: `${diagram.viewWidth}px` }"
            :viewBox="`0 0 ${diagram.viewWidth} 60`"
            xmlns="http://www.w3.org/2000/svg"
          >
            <line
              v-for="(edge, idx) in diagram.edges"
              :key="`e-${idx}`"
              :x1="edge.from.x"
              :y1="edge.from.y"
              :x2="edge.to.x"
              :y2="edge.to.y"
              :style="{ stroke: edge.mutual ? 'var(--graph-edge-mutual)' : 'var(--graph-edge)' }"
              :stroke-width="edge.mutual ? 1.2 : 1"
              stroke-linecap="round"
              :opacity="edge.mutual ? 0.8 : 0.5"
            />
            <g
              v-for="node in diagram.nodes"
              :key="node.address"
            >
              <clipPath :id="`clip-${market.id}-${node.address}`">
                <circle
                  :cx="node.x"
                  :cy="node.y"
                  r="6"
                />
              </clipPath>
              <circle
                :cx="node.x"
                :cy="node.y"
                r="6"
                :style="{ fill: getAssetLogoUrl(node.assetAddress, node.assetSymbol) ? 'var(--graph-node-bg)' : stringToColor(node.assetSymbol), stroke: 'var(--graph-node-border)' }"
                stroke-width="0.5"
              />
              <image
                v-if="getAssetLogoUrl(node.assetAddress, node.assetSymbol)"
                :x="node.x - 6"
                :y="node.y - 6"
                width="12"
                height="12"
                :href="getAssetLogoUrl(node.assetAddress, node.assetSymbol)"
                :clip-path="`url(#clip-${market.id}-${node.address})`"
              />
              <text
                v-else
                :x="node.x"
                :y="node.y + 2"
                text-anchor="middle"
                style="fill: var(--graph-node-text)"
                font-size="5"
                font-weight="600"
              >{{ node.assetSymbol.slice(0, 2) }}</text>
            </g>
          </svg>
        </div>
      </template>
    </div>

    <!-- Mobile: additional rows matching lend card style -->
    <div class="hidden mobile:flex mobile:flex-col gap-12 py-12 px-0">
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">
          Total borrowed
        </div>
        <div class="text-p2 text-content-primary">
          {{ formatCompactUsdValue(market.metrics.totalBorrowed) }}
        </div>
      </div>
      <template
        v-for="(bestRoe, bestRoeIdx) in [getBestMaxRoe(market)]"
        :key="'max-roe-mobile-' + bestRoeIdx"
      >
        <UiModalPreviewTrigger
          v-if="bestRoe.value > 0"
          :component="VaultMaxRoeModal"
          :modal-data="() => getMaxRoeModalData(bestRoe)"
          aria-label="Max ROE details"
        >
          <div class="flex w-full justify-between">
            <div class="text-content-tertiary text-p3 flex items-center gap-4 whitespace-nowrap">
              Max ROE
              <SvgIcon
                class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors"
                name="info-circle"
              />
            </div>
            <div class="text-p2 text-content-primary flex flex-wrap items-center justify-end gap-x-4">
              <span class="flex items-center gap-4 shrink-0">
                <SvgIcon
                  v-if="bestRoe.hasRewards"
                  name="sparks"
                  class="!w-20 !h-20 text-accent-500 shrink-0 hover:text-accent-400 transition-colors"
                />
                {{ formatNumber(bestRoe.value, 2, 2) }}%
              </span>
              <span
                v-if="bestRoe.pair"
                class="text-p4 text-content-muted"
                :class="isExpanded ? '' : 'truncate max-w-[100px]'"
              >{{ bestRoe.pair }}</span>
            </div>
          </div>
        </UiModalPreviewTrigger>
      </template>
    </div>
  </button>
</template>
