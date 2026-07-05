<script setup lang="ts">
import { isEVault, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import {
  type MatrixViewId,
  type AttributeMatrixData,
  type AttributeCell,
  type AttributeMatrixColumn,
  type AttributeRow,
  type VaultUsdCacheEntry,
  type VaultApyCacheEntry,
  buildAttributeRowCells,
  filterAttributeRowsByBadDebtAvailability,
  isVaultType,
} from '~/utils/discoveryCalculations'
import type { VaultBadDebtCacheEntry } from '~/utils/vault-bad-debt'
import { getEntitiesByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { VaultHooksInfoModal } from '#components'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { buildAllocatedVaultExposureDisplayItems, buildFallbackVaultExposureDisplay, hasMissingUtilizedExposureSplit, type ExposureValueState, type VaultExposureDisplay } from '~/utils/vault/exposure-display'

const props = defineProps<{
  data: AttributeMatrixData
  view: MatrixViewId
  usdCache: Map<string, VaultUsdCacheEntry>
  apyCache: Map<string, VaultApyCacheEntry>
  badDebtCache: Map<string, VaultBadDebtCacheEntry>
  showBadDebtColumn: boolean
  selectedHeader: { address: string, axis: 'row' | 'column' } | null
}>()

defineEmits<{
  selectHeader: [address: string, axis: 'row' | 'column']
}>()

const { isVaultGovernorVerified } = useVaults()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
  isOpenInterestEnabled,
} = useCollateralOpenInterest()

// Each AttributeRow renders as a *table column*; each vault renders as a *table row*.
interface AttributeColumn {
  attribute: AttributeRow
  cells: AttributeCell[] // index aligned to data.columns (vaults)
}

const attributeColumns = computed<AttributeColumn[]>(() =>
  filterAttributeRowsByBadDebtAvailability(props.data.rows, props.showBadDebtColumn)
    .map(attribute => ({
      attribute,
      cells: buildAttributeRowCells(attribute, props.data.columns, props.usdCache, props.apyCache, props.badDebtCache, props.showBadDebtColumn),
    })),
)

const getHooksModalData = (vault: AttributeMatrixColumn) => ({
  props: {
    vault: vault.vault,
  },
})

const canShowHooksModal = (vault: AttributeMatrixColumn, cell: AttributeCell) =>
  cell.hookable && isVaultType(vault.vault)

const entitiesFor = (vault: AttributeMatrixColumn) => getEntitiesByVault(vault.vault)
const hasLiveExposureData = computed(() =>
  isOpenInterestEnabled.value && isOpenInterestLoaded.value && !hasOpenInterestError.value,
)
const isOpenInterestLoading = computed(() =>
  isOpenInterestEnabled.value && !hasOpenInterestError.value && !isOpenInterestLoaded.value,
)
const exposureValueState = computed<ExposureValueState>(() => {
  if (isOpenInterestLoading.value) return 'loading'
  if (hasLiveExposureData.value) return 'ready'
  return 'unavailable'
})

const exposureByVault = computed(() => {
  const result = new Map<string, VaultExposureDisplay>()
  if (props.view !== 'stats') return result

  for (const column of props.data.columns) {
    if (!isEVault(column.vault)) continue
    const totalExposureUsd = props.usdCache.get(column.address)?.supplyUsd
    const groups = getCollateralExposureGroups(
      getCollateralExposurePairs(
        column.vault,
        addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
      ),
      getOpenInterestForVault(column.address),
    )

    if (hasLiveExposureData.value && !hasMissingUtilizedExposureSplit(groups, column.vault.utilization)) {
      if (totalExposureUsd === undefined) {
        result.set(column.address, { items: [], valueState: 'unavailable' })
        continue
      }

      result.set(column.address, {
        items: buildAllocatedVaultExposureDisplayItems({
          collateralGroups: groups,
          totalExposureUsd,
          idleAsset: column.vault.asset,
          utilization: column.vault.utilization,
        }),
        valueState: 'ready',
      })
      continue
    }
    if (isOpenInterestLoading.value) {
      result.set(column.address, { items: [], valueState: 'loading' })
      continue
    }

    // Open-interest split unknown (v3 disabled for the chain, fetch error, or
    // missing rows) — degrade to the RPC-derived fallback per vault.
    result.set(column.address, buildFallbackVaultExposureDisplay({
      collateralGroups: groups,
      totalExposureUsd: totalExposureUsd ?? 0,
      totalSupplyState: totalExposureUsd === undefined ? 'unavailable' : 'ready',
      idleAsset: column.vault.asset,
      utilization: column.vault.utilization,
    }))
  }
  return result
})

const getVaultExposureItems = (vault: AttributeMatrixColumn) =>
  exposureByVault.value.get(vault.address)?.items ?? []

const getVaultExposureValueState = (vault: AttributeMatrixColumn): ExposureValueState =>
  exposureByVault.value.get(vault.address)?.valueState ?? exposureValueState.value

watchEffect(() => {
  if (props.view !== 'stats') return
  if (!isOpenInterestEnabled.value) return
  if (!props.data.columns.some(column => isEVault(column.vault))) return
  void loadOpenInterest()
})

// Hover state — used to highlight the matching vault row label and attribute
// column header so users can scan from a cell back to its labels.
const hoveredCell = ref<{ vaultAddr: string, attributeId: string } | null>(null)

const isVaultRowHighlighted = (vaultAddr: string): boolean =>
  hoveredCell.value?.vaultAddr === vaultAddr
  || (props.selectedHeader?.axis === 'row' && props.selectedHeader.address === vaultAddr)

const isAttributeColumnHighlighted = (attributeId: string): boolean =>
  hoveredCell.value?.attributeId === attributeId

const cellDataValue = (cell: AttributeCell, vault: AttributeMatrixColumn): string | number => {
  if (cell.kind === 'exposure') {
    if (getVaultExposureValueState(vault) !== 'ready') return getVaultExposureValueState(vault)
    return getVaultExposureItems(vault).map(item => item.label ?? item.asset.symbol).join(',')
  }
  return props.view === 'stats' ? cell.display : (cell.numeric ?? cell.display)
}
</script>

<template>
  <div
    class="px-16 pb-12 flex items-center justify-center"
    data-id="attribute-matrix"
    data-list="attribute-matrix"
    :data-key="view"
    :data-field="view"
    :data-row-count="data.columns.length"
    :data-column-count="attributeColumns.length"
  >
    <div
      class="relative isolate max-h-[60vh] overflow-auto rounded-8 border border-line-subtle px-12 pb-12 pt-0"
    >
      <table class="border-separate border-spacing-0">
        <thead class="sticky top-0 z-30 bg-surface">
          <tr>
            <th
              class="text-left text-p5 text-content-muted font-normal py-6 pr-10 pl-6 sticky left-0 bg-surface z-40 border-b border-r border-white/[0.04]"
            >
              <div class="flex flex-col leading-tight">
                <span>Attribute &#8594;</span>
                <span>Vault &#8595;</span>
              </div>
            </th>
            <th
              v-for="col in attributeColumns"
              :key="col.attribute.id"
              class="text-center text-p4 text-content-secondary font-medium py-6 px-8 whitespace-nowrap bg-surface border-b border-r border-white/[0.04] transition-colors"
              data-id="attribute-matrix-column"
              data-list="attribute-matrix-column"
              :data-key="col.attribute.id"
              :data-field="col.attribute.id"
              :class="isAttributeColumnHighlighted(col.attribute.id) ? '!bg-white/[0.06] text-content-primary' : ''"
            >
              <span class="inline-flex items-center justify-center gap-4">
                <span>{{ col.attribute.label }}</span>
                <UiHoverPreviewTooltip
                  v-if="col.attribute.tooltip"
                  :title="col.attribute.label"
                  :text="col.attribute.tooltip"
                  placement="top-start"
                />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(vault, vaultIdx) in data.columns"
            :key="vault.address"
            data-id="attribute-matrix-row"
            data-list="attribute-matrix-row"
            :data-key="vault.address"
            :data-vault-address="vault.address"
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              data-id="attribute-matrix-row-header"
              data-list="attribute-matrix-row-header"
              :data-key="vault.address"
              :data-vault-address="vault.address"
              :class="
                selectedHeader?.address === vault.address
                  && selectedHeader?.axis === 'row'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : isVaultRowHighlighted(vault.address)
                    ? (vault.isExternal ? 'text-content-tertiary !bg-white/[0.06]' : 'text-content-primary !bg-white/[0.06]')
                    : (vault.isExternal
                      ? 'text-content-tertiary hover:bg-white/[0.04]'
                      : 'text-content-primary hover:bg-white/[0.04]')
              "
              @click.stop="$emit('selectHeader', vault.address, 'row')"
            >
              <div class="flex items-center gap-4">
                <AssetAvatar
                  class="shrink-0"
                  :asset="{ address: vault.assetAddress, symbol: vault.symbol }"
                  size="16"
                />
                {{ vault.symbol }}
              </div>
            </td>
            <td
              v-for="col in attributeColumns"
              :key="col.attribute.id"
              class="text-center py-6 px-8 min-w-[80px] transition-colors border-b border-r border-white/[0.04]"
              data-id="attribute-matrix-cell"
              data-list="attribute-matrix-cell"
              :data-key="`${vault.address}:${col.attribute.id}`"
              :data-vault-address="vault.address"
              :data-field="col.attribute.id"
              :data-value="cellDataValue(col.cells[vaultIdx], vault)"
              :class="(isVaultRowHighlighted(vault.address) || isAttributeColumnHighlighted(col.attribute.id)) ? '!bg-white/[0.06]' : ''"
              @mouseenter="hoveredCell = { vaultAddr: vault.address, attributeId: col.attribute.id }"
              @mouseleave="hoveredCell = null"
            >
              <!-- capProgress: number + radial -->
              <template v-if="col.cells[vaultIdx].kind === 'capProgress'">
                <div
                  class="inline-flex items-center justify-center gap-6 text-p5 text-content-secondary whitespace-nowrap"
                >
                  <span>{{ col.cells[vaultIdx].display }}</span>
                  <UiRadialProgress
                    v-if="!col.cells[vaultIdx].capUncapped && col.cells[vaultIdx].capPercent !== undefined"
                    :value="col.cells[vaultIdx].capPercent!"
                    :max="100"
                    class="shrink-0"
                  />
                  <UiHoverPreviewTooltip
                    v-if="col.cells[vaultIdx].hint"
                    :title="col.attribute.label"
                    :text="col.cells[vaultIdx].hint"
                    placement="top-start"
                  />
                </div>
              </template>

              <!-- governor: same precedence as VaultOverviewBlockGeneral —
                   unverified governor wins ("Unknown"), then entities, else
                   "—". Escrow vaults pass `isVaultGovernorVerified` and have
                   no labeled entities, so they fall through to "—". -->
              <template v-else-if="col.cells[vaultIdx].kind === 'governor'">
                <template v-if="isVaultType(vault.vault) && !isVaultGovernorVerified(vault.vault)">
                  <VaultTypeChip
                    :vault="vault.vault"
                    type="unknown"
                    class="inline-flex !py-2 !px-6 !text-p5"
                  />
                </template>
                <template v-else-if="entitiesFor(vault).length">
                  <div class="inline-flex items-center justify-center gap-6 flex-wrap">
                    <div
                      v-for="(entity, idx) in entitiesFor(vault)"
                      :key="idx"
                      class="inline-flex items-center gap-4"
                    >
                      <BaseAvatar
                        :label="entity.name"
                        :src="getEulerLabelEntityLogo(entity.logo)"
                        class="icon--16"
                      />
                      <span class="text-p5 text-content-primary whitespace-nowrap">{{ entity.name }}</span>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <span class="text-p5 text-content-secondary whitespace-nowrap">—</span>
                </template>
              </template>

              <!-- hooks: text + optional clickable info icon -->
              <template v-else-if="col.cells[vaultIdx].kind === 'hooks'">
                <UiModalPreviewTrigger
                  v-if="canShowHooksModal(vault, col.cells[vaultIdx])"
                  :component="VaultHooksInfoModal"
                  :modal-data="() => getHooksModalData(vault)"
                  aria-label="Show hooked operations details"
                >
                  <span class="inline-flex items-center justify-center gap-4 text-p5 text-content-primary hover:text-accent-500 cursor-pointer transition-colors">
                    <span>{{ col.cells[vaultIdx].display }}</span>
                    <SvgIcon
                      name="info-circle"
                      class="!w-12 !h-12 shrink-0"
                    />
                  </span>
                </UiModalPreviewTrigger>
                <span
                  v-else
                  class="text-p5 text-content-secondary"
                >{{ col.cells[vaultIdx].display }}</span>
              </template>

              <!-- exposure: Morpho-style asset stack + full preview list -->
              <template v-else-if="col.cells[vaultIdx].kind === 'exposure'">
                <VaultExposureSummary
                  :items="getVaultExposureItems(vault)"
                  :value-state="getVaultExposureValueState(vault)"
                  :max-visible="4"
                  avatar-size="16"
                  placement="top"
                />
              </template>

              <!-- text (default) -->
              <template v-else>
                <span
                  class="inline-flex items-center justify-center gap-4 text-p5 text-content-secondary whitespace-nowrap"
                >
                  <span>{{ col.cells[vaultIdx].display }}</span>
                  <UiHoverPreviewTooltip
                    v-if="col.cells[vaultIdx].hint"
                    :title="col.attribute.label"
                    :text="col.cells[vaultIdx].hint"
                    placement="top-start"
                  />
                </span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <p
    v-if="!selectedHeader"
    class="text-h6 text-content-primary text-center leading-relaxed px-16 pb-12"
  >
    Tap a vault row to see lending/borrowing options below.
  </p>
</template>
