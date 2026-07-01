<script setup lang="ts">
import type { Placement } from '@floating-ui/vue'
import { UiHoverPreviewTooltipModal } from '#components'

type Section = { title: string, text: string }
type HoverPreviewTooltipCommonProps = {
  placement?: Placement
  ariaLabel?: string
  icon?: string
  iconClass?: string
}
type HoverPreviewTooltipProps
  = | (HoverPreviewTooltipCommonProps & { title: string, text: string, sections?: never })
    | (HoverPreviewTooltipCommonProps & { sections: Section[], title?: string, text?: never })

const props = withDefaults(defineProps<HoverPreviewTooltipProps>(), {
  placement: 'top',
  icon: 'info-circle',
  iconClass: 'text-content-muted hover:text-content-secondary',
})

const resolvedAriaLabel = computed(() => props.ariaLabel || props.title || 'Show details')

const modalData = computed(() => ({
  props: props.sections
    ? props.sections.length === 1 && !props.title
      ? {
          modalTitle: props.sections[0].title,
          text: props.sections[0].text,
        }
      : {
          modalTitle: props.title || 'Details',
          sections: props.sections,
        }
    : {
        modalTitle: props.title,
        text: props.text,
      },
}))
</script>

<template>
  <UiModalPreviewTrigger
    :component="UiHoverPreviewTooltipModal"
    :modal-data="modalData"
    :aria-label="resolvedAriaLabel"
    :placement="props.placement"
    :clickable="false"
  >
    <slot>
      <SvgIcon
        class="!w-16 !h-16 transition-colors"
        :class="props.iconClass"
        :name="props.icon"
      />
    </slot>
  </UiModalPreviewTrigger>
</template>
