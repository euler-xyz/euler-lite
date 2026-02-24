<script setup lang="ts">
import type { MarketGroup } from '~/entities/lend-discovery'
import { formatCompactUsdValue, formatNumber, stringToColor } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { getAssetLogoUrl } from '~/composables/useTokens'
import {
  getMarketEntities,
  getDeprecatedVaultCount,
  getMiniDiagram,
  getBorrowableVaults,
  findVault,
  type BestNetApyResult,
} from '~/utils/discoveryCalculations'

defineProps<{
  market: MarketGroup
  isExpanded: boolean
}>()

defineEmits<{
  toggle: []
}>()

const { withIntrinsicSupplyApy, withIntrinsicBorrowApy } = useIntrinsicApy()
const { getBorrowRewardApy, getSupplyRewardApy } = useRewardsApy()
const { products } = useEulerLabels()

const getProductDescription = (market: MarketGroup): string => {
  if (market.source !== 'product') return ''
  return products[market.id]?.description ?? ''
}

const getBestNetApy = (market: MarketGroup): BestNetApyResult => {
  const borrowable = getBorrowableVaults(market)
  let best = -Infinity
  let bestHasRewards = false
  let bestPair = ''

  for (const liability of borrowable) {
    const borrowBase = nanoToValue(liability.interestRateInfo.borrowAPY, 25)
    const borrowApy = withIntrinsicBorrowApy(borrowBase, liability.asset.address)

    for (const ltv of liability.collateralLTVs) {
      if (ltv.borrowLTV === 0n) continue
      const collateral = findVault(market, ltv.collateral)
      if (!collateral) continue

      const supplyBase = nanoToValue(collateral.interestRateInfo.supplyAPY, 25)
      const supplyApy = withIntrinsicSupplyApy(supplyBase, collateral.asset.address)
      const supplyRewards = getSupplyRewardApy(collateral.address)
      const borrowRewards = getBorrowRewardApy(liability.address, collateral.address)

      const netApy = (supplyApy + supplyRewards) - (borrowApy - borrowRewards)
      if (netApy > best) {
        best = netApy
        bestHasRewards = supplyRewards > 0 || borrowRewards > 0
        bestPair = `${collateral.asset.symbol}/${liability.asset.symbol}`
      }
    }
  }

  return { value: Number.isFinite(best) && best > -Infinity ? best : 0, hasRewards: bestHasRewards, pair: bestPair }
}
</script>

<template>
  <button
    class="w-full text-left cursor-pointer p-16"
    @click="$emit('toggle')"
  >
    <div class="flex items-start pb-12 border-b border-line-subtle mobile:flex-wrap">
      <template
        v-for="(marketEntities, entitiesIdx) in [getMarketEntities(market)]"
        :key="'entities-' + entitiesIdx"
      >
        <BaseAvatar
          v-if="marketEntities.logos.length > 0"
          class="icon--40 shrink-0"
          :src="marketEntities.logos"
          :label="marketEntities.name"
        />
        <div
          class="flex-grow min-w-0"
          :class="marketEntities.logos.length > 0 ? 'ml-12' : ''"
        >
          <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-8">
            <template v-if="marketEntities.name">
              {{ marketEntities.name }}
            </template>
            <template v-else-if="market.curator">
              {{ market.curator.name }}
            </template>
            <template v-else>
              Ungrouped
            </template>
            <span
              v-if="market.metrics.hasFeatured"
              class="inline-flex items-center gap-4 rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
            >
              <SvgIcon
                name="star"
                class="!w-14 !h-14"
              />
              Featured
            </span>
          </div>
          <div class="text-h5 text-content-primary">
            {{ market.name }}
          </div>
          <div
            v-if="getProductDescription(market)"
            class="text-p3 text-content-tertiary mt-4"
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
        <div class="flex flex-col items-end shrink-0 ml-12 text-content-tertiary text-p3 mobile:flex-row mobile:w-full mobile:items-center mobile:gap-8 mobile:mt-8 mobile:ml-0">
          <span>{{ diagram.assetCount }} assets</span>
          <span class="text-content-muted">{{ diagram.pairCount }} pairs</span>
          <span
            v-if="getDeprecatedVaultCount(market) > 0"
            class="text-warning-500 text-p5 mt-4 mobile:mt-0"
          >
            {{ getDeprecatedVaultCount(market) }} deprecated
          </span>
        </div>
      </template>
    </div>

    <div class="flex pt-12 items-center mobile:flex-wrap mobile:gap-y-12">
      <div class="flex-1 flex gap-12 mobile:grid mobile:grid-cols-2 mobile:gap-y-12 mobile:gap-x-12">
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Total supply
          </div>
          <div class="text-p2 text-content-primary">
            {{ formatCompactUsdValue(market.metrics.totalTVL) }}
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Total borrowed
          </div>
          <div class="text-p2 text-content-primary">
            {{ formatCompactUsdValue(market.metrics.totalBorrowed) }}
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-content-tertiary text-p3 mb-4">
            Available liquidity
          </div>
          <div class="text-p2 text-content-primary">
            {{ formatCompactUsdValue(market.metrics.totalAvailableLiquidity) }}
          </div>
        </div>
        <template
          v-for="(bestNet, bestNetIdx) in [getBestNetApy(market)]"
          :key="'net-apy-' + bestNetIdx"
        >
          <div
            v-if="bestNet.value !== 0"
            class="flex-1 min-w-0"
          >
            <div class="text-content-tertiary text-p3 mb-4">
              Best net APY
            </div>
            <div class="text-p2 text-content-primary flex items-center gap-4 min-w-0 mobile:overflow-hidden">
              <SvgIcon
                v-if="bestNet.hasRewards"
                name="sparks"
                class="!w-12 !h-12 text-accent-500 shrink-0"
              />
              <span class="shrink-0">{{ formatNumber(bestNet.value, 2, 2) }}%</span>
              <span
                v-if="bestNet.pair"
                class="text-p4 text-content-muted min-w-0 truncate"
              >{{ bestNet.pair }}</span>
            </div>
          </div>
        </template>
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
              :stroke="edge.mutual ? '#6b7280' : '#4b5563'"
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
                :fill="getAssetLogoUrl(node.assetAddress, node.assetSymbol) ? '#1f2937' : stringToColor(node.assetSymbol)"
                stroke="#4b5563"
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
                fill="white"
                font-size="5"
                font-weight="600"
              >{{ node.assetSymbol.slice(0, 2) }}</text>
            </g>
          </svg>
        </div>
      </template>
    </div>
  </button>
</template>
