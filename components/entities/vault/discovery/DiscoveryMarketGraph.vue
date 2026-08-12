<script setup lang="ts">
import { isEulerEarn, isSecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { MarketGroup, MiniDiagramData } from '~/entities/lend-discovery'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { isVaultDeprecated, isVaultKeyring, isVaultCyclicalNote } from '~/utils/eulerLabelsUtils'
import { hasResolvedGovernorAdmin } from '~/utils/vault/governor-verification'
import { stringToColor } from '~/utils/string-utils'
import { getEnlargedDiagram, getArrow, getLabelPosition, getGraphConnectedAddresses, isNodeRampingDown, isExternalCollateral, findVault } from '~/utils/discoveryCalculations'

const props = defineProps<{
  market: MarketGroup
  diagram: MiniDiagramData
  selectedNodeAddress: string | null
}>()

defineEmits<{
  selectNode: [address: string]
}>()

const isGraphNodeHighlighted = (address: string): boolean => {
  if (!props.selectedNodeAddress) return true
  return (
    address === props.selectedNodeAddress
    || getGraphConnectedAddresses(props.diagram, props.selectedNodeAddress).has(
      address,
    )
  )
}

const isGraphEdgeHighlighted = (fromAddr: string, toAddr: string): boolean => {
  if (!props.selectedNodeAddress) return true
  return (
    fromAddr === props.selectedNodeAddress
    || toAddr === props.selectedNodeAddress
  )
}

const isNodeCyclicalNote = (address: string): boolean => {
  return isVaultCyclicalNote(address)
}

const { isVaultGovernorVerified, isSecuritizeGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

// Same signal as the per-pair "Unknown" risk-manager pill: the vault resolved,
// but its governor/owner isn't part of any declared product entity. Applies to
// group members too — the curator's label attests membership, not that the
// declared entity actually holds the governor keys.
const isNodeRiskManagerUnknown = (address: string): boolean => {
  const vault = findVault(props.market, address)
  if (!vault) return false
  if (isEulerEarn(vault)) return !isEarnVaultOwnerVerified(vault)
  if (isSecuritizeCollateralVault(vault)) return !isSecuritizeGovernorVerified(vault)
  // Governance can be unresolved on lazily-hydrated collateral vaults — the
  // guard is VALUE-based because SDK EVault instances always own the
  // property. Don't flag what simply hasn't been fetched yet.
  if (!hasResolvedGovernorAdmin(vault)) return false
  return !isVaultGovernorVerified(vault)
}
</script>

<template>
  <template
    v-for="(enlarged, enlargedIdx) in [getEnlargedDiagram(diagram)]"
    :key="'edata-' + enlargedIdx"
  >
    <div
      class="px-16 pb-12 flex items-center justify-center"
      data-id="discovery-graph"
      data-list="discovery-graph"
      :data-key="market.id"
      :data-node-count="enlarged.nodes.length"
      :data-edge-count="enlarged.edges.length"
    >
      <svg
        class="h-auto max-w-full"
        :style="{ width: `${Math.min(enlarged.viewWidth * 1.5, 900)}px` }"
        :viewBox="`0 0 ${enlarged.viewWidth} ${enlarged.viewHeight}`"
        xmlns="http://www.w3.org/2000/svg"
      >
        <!-- Edges -->
        <template
          v-for="(edge, idx) in enlarged.edges"
          :key="`edge-${idx}`"
        >
          <!-- Highlighted + selected: show directed arrows in accent color -->
          <template
            v-if="
              selectedNodeAddress
                && isGraphEdgeHighlighted(edge.from.address, edge.to.address)
            "
          >
            <line
              data-id="discovery-graph-edge"
              data-list="discovery-graph-edge"
              :data-key="`${edge.from.address}:${edge.to.address}`"
              :data-market-id="market.id"
              :data-from-address="edge.from.address"
              :data-to-address="edge.to.address"
              :data-mutual="edge.mutual"
              :x1="edge.from.x"
              :y1="edge.from.y"
              :x2="
                getArrow(
                  edge.from.x,
                  edge.from.y,
                  edge.to.x,
                  edge.to.y,
                  enlarged.nodeRadius,
                ).lineX2
              "
              :y2="
                getArrow(
                  edge.from.x,
                  edge.from.y,
                  edge.to.x,
                  edge.to.y,
                  enlarged.nodeRadius,
                ).lineY2
              "
              style="stroke: var(--accent-500)"
              :stroke-width="0.8"
              stroke-linecap="round"
              opacity="0.9"
            />
            <polygon
              :points="
                getArrow(
                  edge.from.x,
                  edge.from.y,
                  edge.to.x,
                  edge.to.y,
                  enlarged.nodeRadius,
                ).triangle
              "
              style="fill: var(--accent-500)"
              opacity="0.9"
            />
            <template v-if="edge.mutual">
              <line
                data-id="discovery-graph-edge"
                data-list="discovery-graph-edge"
                :data-key="`${edge.to.address}:${edge.from.address}`"
                :data-market-id="market.id"
                :data-from-address="edge.to.address"
                :data-to-address="edge.from.address"
                data-mutual="true"
                :x1="edge.to.x"
                :y1="edge.to.y"
                :x2="
                  getArrow(
                    edge.to.x,
                    edge.to.y,
                    edge.from.x,
                    edge.from.y,
                    enlarged.nodeRadius,
                  ).lineX2
                "
                :y2="
                  getArrow(
                    edge.to.x,
                    edge.to.y,
                    edge.from.x,
                    edge.from.y,
                    enlarged.nodeRadius,
                  ).lineY2
                "
                style="stroke: var(--accent-500)"
                :stroke-width="0.8"
                stroke-linecap="round"
                opacity="0.9"
              />
              <polygon
                :points="
                  getArrow(
                    edge.to.x,
                    edge.to.y,
                    edge.from.x,
                    edge.from.y,
                    enlarged.nodeRadius,
                  ).triangle
                "
                style="fill: var(--accent-500)"
                opacity="0.9"
              />
            </template>
          </template>
          <!-- Default state or dimmed -->
          <line
            v-else
            data-id="discovery-graph-edge"
            data-list="discovery-graph-edge"
            :data-key="`${edge.from.address}:${edge.to.address}`"
            :data-market-id="market.id"
            :data-from-address="edge.from.address"
            :data-to-address="edge.to.address"
            :data-mutual="edge.mutual"
            :x1="edge.from.x"
            :y1="edge.from.y"
            :x2="edge.to.x"
            :y2="edge.to.y"
            :style="{
              stroke: edge.mutual ? 'var(--graph-edge-mutual)' : 'var(--graph-edge)',
              transition: 'opacity 0.2s, stroke 0.2s',
            }"
            :stroke-width="edge.mutual ? 1.0 : 0.5"
            stroke-linecap="round"
            :opacity="selectedNodeAddress ? 0.15 : edge.mutual ? 0.9 : 0.5"
          />
        </template>

        <!-- Nodes -->
        <g
          v-for="node in enlarged.nodes"
          :key="node.address"
          :class="node.hasVaultData === false ? 'cursor-default' : 'cursor-pointer'"
          data-id="discovery-graph-node"
          data-list="discovery-graph-node"
          :data-key="node.address"
          :data-market-id="market.id"
          :data-vault-address="node.address"
          :data-asset-address="node.assetAddress"
          :data-symbol="node.assetSymbol"
          :opacity="isGraphNodeHighlighted(node.address) ? 1 : 0.25"
          style="transition: opacity 0.2s"
          @click.stop="node.hasVaultData !== false && $emit('selectNode', node.address)"
        >
          <clipPath :id="`graph-clip-${market.id}-${node.address}`">
            <circle
              :cx="node.x"
              :cy="node.y"
              r="12"
            />
          </clipPath>
          <circle
            :cx="node.x"
            :cy="node.y"
            r="12"
            :style="{ fill: getAssetLogoUrl(node.assetAddress, node.assetSymbol) ? 'var(--graph-node-bg)' : stringToColor(node.assetSymbol), stroke: 'var(--graph-node-border)' }"
            stroke-width="1"
          />
          <image
            v-if="getAssetLogoUrl(node.assetAddress, node.assetSymbol)"
            :x="node.x - 12"
            :y="node.y - 12"
            width="24"
            height="24"
            :href="getAssetLogoUrl(node.assetAddress, node.assetSymbol)"
            :clip-path="`url(#graph-clip-${market.id}-${node.address})`"
          />
          <text
            v-else
            :x="node.x"
            :y="node.y + 4"
            text-anchor="middle"
            style="fill: var(--graph-node-text)"
            font-size="10"
            font-weight="600"
          >
            {{ node.assetSymbol.slice(0, 2) }}
          </text>
          <!-- Unknown risk-manager badge: governor/owner not in any declared
               product entity (members and externals alike — same signal as the
               per-pair "Unknown" pill), or vault truly missing -->
          <g v-if="node.isUnknown || isNodeRiskManagerUnknown(node.address)">
            <circle
              :cx="node.x + 9"
              :cy="node.y - 9"
              r="6"
              style="fill: var(--error-500)"
            />
            <text
              :x="node.x + 9"
              :y="node.y - 5.5"
              text-anchor="middle"
              fill="white"
              font-size="9"
              font-weight="700"
            >
              !
            </text>
          </g>
          <!-- Deprecated badge -->
          <g v-else-if="isVaultDeprecated(node.address)">
            <circle
              :cx="node.x + 9"
              :cy="node.y - 9"
              r="6"
              style="fill: var(--warning-500)"
            />
            <text
              :x="node.x + 9"
              :y="node.y - 5.5"
              text-anchor="middle"
              fill="white"
              font-size="9"
              font-weight="700"
            >
              !
            </text>
          </g>
          <!-- Ramping down badge -->
          <g v-else-if="isNodeRampingDown(market, node.address)">
            <circle
              :cx="node.x + 9"
              :cy="node.y - 9"
              r="6"
              style="fill: var(--warning-500)"
            />
            <path
              :d="`M${node.x + 11} ${node.y - 11} l-3 3 m3 0 l-3 0 l0 -3`"
              fill="none"
              stroke="white"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </g>
          <!-- Keyring (private vault) badge -->
          <g v-else-if="isVaultKeyring(node.address)">
            <circle
              :cx="node.x + 9"
              :cy="node.y - 9"
              r="6"
              style="fill: var(--accent-600)"
            />
            <!-- Shield icon -->
            <path
              :d="`M${node.x + 9} ${node.y - 12.5} l-2.5 1 v2.2 c0 1.5 1 2.5 2.5 3 c1.5 -0.5 2.5 -1.5 2.5 -3 v-2.2 z`"
              fill="white"
            />
          </g>
          <!-- Cyclical note badge -->
          <g v-else-if="isNodeCyclicalNote(node.address)">
            <circle
              :cx="node.x + 9"
              :cy="node.y - 9"
              r="6"
              style="fill: var(--accent-500)"
            />
            <text
              :x="node.x + 9"
              :y="node.y - 5.8"
              text-anchor="middle"
              fill="white"
              font-size="9"
              font-weight="700"
            >↻</text>
          </g>
          <!-- Asset label -->
          <text
            :x="getLabelPosition(node, enlarged.cx, enlarged.cy).x"
            :y="getLabelPosition(node, enlarged.cx, enlarged.cy).y"
            :text-anchor="
              getLabelPosition(node, enlarged.cx, enlarged.cy).anchor
            "
            class="fill-current"
            :class="
              isExternalCollateral(market, node.address)
                ? 'text-content-tertiary'
                : 'text-content-primary'
            "
            font-size="12"
            font-weight="500"
          >
            {{ node.assetSymbol }}
          </text>
        </g>
      </svg>
    </div>

    <!-- Graph info -->
    <div class="flex justify-center gap-16 text-p3 text-content-tertiary pb-8">
      <span>{{ diagram.assetCount }} assets</span>
      <span>{{ diagram.pairCount }} pairs</span>
    </div>

    <p
      v-if="!selectedNodeAddress"
      class="text-h6 text-content-primary text-center leading-relaxed px-16 pb-12"
    >
      Tap a node to highlight connections and see lending/borrowing options
      below.
    </p>
  </template>
</template>
