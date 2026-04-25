<script setup lang="ts">
import {
  type AttributeMatrixData,
  type AttributeCell,
  type AttributeMatrixColumn,
  type AttributeRow,
  type VaultUsdCacheEntry,
  buildAttributeRowCells,
  getAttributeRowColor,
  isVaultType,
} from '~/utils/discoveryCalculations'
import { getEntitiesByVault } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultHooksInfoModal } from '#components'

const props = defineProps<{
  data: AttributeMatrixData
  usdCache: Map<string, VaultUsdCacheEntry>
  selectedHeader: { address: string, axis: 'row' | 'column' } | null
}>()

defineEmits<{
  selectHeader: [address: string, axis: 'row' | 'column']
}>()

const modal = useModal()

// Each AttributeRow renders as a *table column*; each vault renders as a *table row*.
// We pre-compute one entry per attribute with the per-attribute cells (one per vault)
// and the min/max range needed for the heatmap.
interface AttributeColumn {
  attribute: AttributeRow
  cells: AttributeCell[] // index aligned to data.columns (vaults)
  min: number
  max: number
}

const attributeColumns = computed<AttributeColumn[]>(() =>
  props.data.rows.map((attribute) => {
    const cells = buildAttributeRowCells(attribute, props.data.columns, props.usdCache)
    let min = Infinity
    let max = -Infinity
    for (const c of cells) {
      if (c.numeric === undefined || !Number.isFinite(c.numeric)) continue
      if (c.numeric < min) min = c.numeric
      if (c.numeric > max) max = c.numeric
    }
    if (!Number.isFinite(min)) {
      min = 0
      max = 0
    }
    return { attribute, cells, min, max }
  }),
)

const cellBgColor = (column: AttributeColumn, cell: AttributeCell): string =>
  getAttributeRowColor(cell.numeric, column.min, column.max, column.attribute.direction)

const onHooksClick = (vault: AttributeMatrixColumn) => {
  if (!isVaultType(vault.vault)) return
  modal.open(VaultHooksInfoModal, { props: { vault: vault.vault } })
}

const entitiesFor = (vault: AttributeMatrixColumn) => getEntitiesByVault(vault.vault)

// Hover state — used to highlight the matching vault row label and attribute
// column header so users can scan from a cell back to its labels.
const hoveredCell = ref<{ vaultAddr: string, attributeId: string } | null>(null)

const isVaultRowHighlighted = (vaultAddr: string): boolean =>
  hoveredCell.value?.vaultAddr === vaultAddr
  || (props.selectedHeader?.axis === 'row' && props.selectedHeader.address === vaultAddr)

const isAttributeColumnHighlighted = (attributeId: string): boolean =>
  hoveredCell.value?.attributeId === attributeId
</script>

<template>
  <div class="px-16 pb-12 flex items-center justify-center">
    <div
      class="relative max-h-[60vh] overflow-auto rounded-8 border border-line-subtle p-12"
    >
      <table class="border-collapse">
        <thead class="sticky top-0 z-20 bg-surface">
          <tr>
            <th
              class="text-left text-p5 text-content-muted font-normal py-6 pr-10 pl-6 sticky left-0 bg-surface z-30 border-b border-r border-white/[0.04]"
            >
              <div class="flex flex-col leading-tight">
                <span>Attribute &#8594;</span>
                <span>Vault &#8595;</span>
              </div>
            </th>
            <th
              v-for="col in attributeColumns"
              :key="col.attribute.id"
              class="text-center text-p4 text-content-secondary font-medium py-6 px-8 whitespace-nowrap border-b border-r border-white/[0.04] transition-colors"
              :class="isAttributeColumnHighlighted(col.attribute.id) ? '!bg-white/[0.06] text-content-primary' : ''"
            >
              <span :title="col.attribute.tooltip">{{ col.attribute.label }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(vault, vaultIdx) in data.columns"
            :key="vault.address"
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              :class="
                selectedHeader?.address === vault.address
                  && selectedHeader?.axis === 'row'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : isVaultRowHighlighted(vault.address)
                    ? 'text-content-primary !bg-white/[0.06]'
                    : 'text-content-primary hover:bg-white/[0.04]'
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
              :class="(isVaultRowHighlighted(vault.address) || isAttributeColumnHighlighted(col.attribute.id)) ? '!bg-white/[0.06]' : ''"
              :style="{ backgroundColor: cellBgColor(col, col.cells[vaultIdx]) }"
              @mouseenter="hoveredCell = { vaultAddr: vault.address, attributeId: col.attribute.id }"
              @mouseleave="hoveredCell = null"
            >
              <!-- capProgress: number + radial -->
              <template v-if="col.cells[vaultIdx].kind === 'capProgress'">
                <div
                  class="inline-flex items-center justify-center gap-6 text-p5 text-content-secondary whitespace-nowrap"
                  :title="col.cells[vaultIdx].hint"
                >
                  <span>{{ col.cells[vaultIdx].display }}</span>
                  <UiRadialProgress
                    v-if="!col.cells[vaultIdx].capUncapped && col.cells[vaultIdx].capPercent !== undefined"
                    :value="col.cells[vaultIdx].capPercent!"
                    :max="100"
                    class="shrink-0"
                  />
                </div>
              </template>

              <!-- governor: entity logos + names, or unknown chip -->
              <template v-else-if="col.cells[vaultIdx].kind === 'governor'">
                <template v-if="entitiesFor(vault).length">
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
                  <VaultTypeChip
                    :vault="vault.vault"
                    type="unknown"
                    class="inline-flex !py-2 !px-6 !text-p5"
                  />
                </template>
              </template>

              <!-- hooks: text + optional clickable info icon -->
              <template v-else-if="col.cells[vaultIdx].kind === 'hooks'">
                <button
                  v-if="col.cells[vaultIdx].hookable"
                  type="button"
                  class="inline-flex items-center justify-center gap-4 text-p5 text-content-primary hover:text-accent-500 cursor-pointer transition-colors"
                  @click.stop="onHooksClick(vault)"
                >
                  <span>{{ col.cells[vaultIdx].display }}</span>
                  <SvgIcon
                    name="info-circle"
                    class="!w-12 !h-12 shrink-0"
                  />
                </button>
                <span
                  v-else
                  class="text-p5 text-content-secondary"
                >{{ col.cells[vaultIdx].display }}</span>
              </template>

              <!-- text (default) -->
              <template v-else>
                <span
                  class="text-p5 text-content-secondary whitespace-nowrap"
                  :title="col.cells[vaultIdx].hint"
                >{{ col.cells[vaultIdx].display }}</span>
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
