<script setup lang="ts">
import type { Vault } from '~/entities/vault'
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

interface RowComputed {
  row: AttributeRow
  cells: AttributeCell[]
  min: number
  max: number
}

const rowsComputed = computed<RowComputed[]>(() =>
  props.data.rows.map((row) => {
    const cells = buildAttributeRowCells(row, props.data.columns, props.usdCache)
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
    return { row, cells, min, max }
  }),
)

const cellBgColor = (
  rowComputed: RowComputed,
  cell: AttributeCell,
): string => getAttributeRowColor(cell.numeric, rowComputed.min, rowComputed.max, rowComputed.row.direction)

const onHooksClick = (col: AttributeMatrixColumn) => {
  if (!isVaultType(col.vault)) return
  modal.open(VaultHooksInfoModal, { props: { vault: col.vault } })
}

// Governor entities resolve via the vault's governorAdmin address, which exists
// on both Vault and SecuritizeVault — the helper only reads that one field.
const entitiesFor = (col: AttributeMatrixColumn) => getEntitiesByVault(col.vault as Vault)
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
              <span>Attribute</span>
            </th>
            <th
              v-for="col in data.columns"
              :key="col.address"
              class="text-center text-p4 font-medium py-6 px-8 whitespace-nowrap border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              :class="
                selectedHeader?.address === col.address
                  && selectedHeader?.axis === 'column'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : 'text-content-primary hover:bg-white/[0.04]'
              "
              @click.stop="$emit('selectHeader', col.address, 'column')"
            >
              <div class="flex flex-col items-center gap-2">
                <AssetAvatar
                  :asset="{ address: col.assetAddress, symbol: col.symbol }"
                  size="16"
                />
                {{ col.symbol }}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="rc in rowsComputed"
            :key="rc.row.id"
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] text-content-primary"
            >
              <span :title="rc.row.tooltip">{{ rc.row.label }}</span>
            </td>
            <td
              v-for="(cell, colIdx) in rc.cells"
              :key="data.columns[colIdx].address"
              class="text-center py-6 px-8 min-w-[80px] transition-colors border-b border-r border-white/[0.04]"
              :style="{ backgroundColor: cellBgColor(rc, cell) }"
            >
              <!-- capProgress: number + radial -->
              <template v-if="cell.kind === 'capProgress'">
                <div
                  class="inline-flex items-center justify-center gap-6 text-p5 text-content-secondary whitespace-nowrap"
                  :title="cell.hint"
                >
                  <span>{{ cell.display }}</span>
                  <UiRadialProgress
                    v-if="!cell.capUncapped && cell.capPercent !== undefined"
                    :value="cell.capPercent"
                    :max="100"
                    class="shrink-0"
                  />
                </div>
              </template>

              <!-- governor: entity logos + names, or unknown chip -->
              <template v-else-if="cell.kind === 'governor'">
                <template v-if="entitiesFor(data.columns[colIdx]).length">
                  <div class="inline-flex items-center justify-center gap-6 flex-wrap">
                    <div
                      v-for="(entity, idx) in entitiesFor(data.columns[colIdx])"
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
                    :vault="data.columns[colIdx].vault"
                    type="unknown"
                    class="inline-flex !py-2 !px-6 !text-p5"
                  />
                </template>
              </template>

              <!-- hooks: text + optional clickable info icon -->
              <template v-else-if="cell.kind === 'hooks'">
                <button
                  v-if="cell.hookable"
                  type="button"
                  class="inline-flex items-center justify-center gap-4 text-p5 text-content-primary hover:text-accent-500 cursor-pointer transition-colors"
                  @click.stop="onHooksClick(data.columns[colIdx])"
                >
                  <span>{{ cell.display }}</span>
                  <SvgIcon
                    name="info-circle"
                    class="!w-12 !h-12 shrink-0"
                  />
                </button>
                <span
                  v-else
                  class="text-p5 text-content-secondary"
                >{{ cell.display }}</span>
              </template>

              <!-- text (default) -->
              <template v-else>
                <span
                  class="text-p5 text-content-secondary whitespace-nowrap"
                  :title="cell.hint"
                >{{ cell.display }}</span>
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
    Tap a column header to see lending/borrowing options below.
  </p>
</template>
