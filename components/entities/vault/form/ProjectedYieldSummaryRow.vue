<script setup lang="ts">
import { ProjectedYieldBreakdownModal } from '#components'
import type { ProjectedYieldDetails } from '~/utils/projected-yield'
import { projectedYieldHasRewards } from '~/utils/projected-yield'
import { formatNumber } from '~/utils/string-utils'

const props = defineProps<{
  label: string
  before?: number | null
  after?: number | null
  details?: ProjectedYieldDetails | null
  estimateOnly?: boolean
}>()

const modalData = computed(() => ({
  props: {
    details: props.details,
  },
}))

const hasRewards = computed(() => projectedYieldHasRewards(props.details))
const beforeDisplay = computed(() => props.before != null ? formatNumber(props.before) : undefined)
const afterDisplay = computed(() => props.after != null ? formatNumber(props.after) : undefined)
</script>

<template>
  <SummaryRow
    class="mobile:flex-col mobile:!items-stretch"
    :label="label"
  >
    <template #label>
      <span class="inline-flex items-center gap-4">
        <span>{{ label }}</span>
        <UiModalPreviewTrigger
          v-if="details"
          class="inline-flex min-w-24 min-h-24 items-center justify-center"
          :component="ProjectedYieldBreakdownModal"
          :modal-data="modalData"
          :aria-label="`Show ${label} projection breakdown`"
          popover-width="wide"
        >
          <SvgIcon
            class="!w-16 !h-16 text-content-muted hover:text-content-secondary transition-colors"
            name="info-circle"
          />
        </UiModalPreviewTrigger>
      </span>
    </template>
    <div class="inline-flex items-center gap-4">
      <UiModalPreviewTrigger
        v-if="details && hasRewards"
        class="inline-flex min-w-24 min-h-24 items-center justify-center"
        :component="ProjectedYieldBreakdownModal"
        :modal-data="modalData"
        :aria-label="`Show ${label} reward breakdown`"
        popover-width="wide"
      >
        <SvgIcon
          class="!w-16 !h-16 text-accent-500"
          name="sparks"
        />
      </UiModalPreviewTrigger>
      <SummaryValue
        :before="beforeDisplay"
        :after="afterDisplay"
        suffix="%"
        :estimate-only="estimateOnly"
      />
    </div>
  </SummaryRow>
</template>
