<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'
import { flip, offset, shift, useFloating, type AlignedPlacement } from '@floating-ui/vue'
import { useModal } from '~/components/ui/composables/useModal'
import { UiFootnoteModal } from '#components'

type Section = { title: string, text: string }
type FootnoteCommonProps = {
  tooltipPlacement?: AlignedPlacement
  customModal?: Component
  icon?: string
}
type FootnoteProps
  = | (FootnoteCommonProps & { title: string, text: string, sections?: never })
    | (FootnoteCommonProps & { sections: Section[], title?: never, text?: never })

const { title, text, sections, tooltipPlacement = 'top-start', customModal, icon = 'info-circle' } = defineProps<FootnoteProps>()

const resolvedSections = computed<Section[]>(() => {
  if (sections && sections.length > 0) return sections
  if (title !== undefined && text !== undefined) return [{ title, text }]
  return []
})

const reference = ref(null)
const floating = ref(null)
const isVisible = ref(false)

const modal = useModal()
const { floatingStyles, update } = useFloating(reference, floating, {
  placement: tooltipPlacement,
  middleware: [
    offset({ mainAxis: 15, crossAxis: -15 }),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
  ],
})

const canHover = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

const onClick = () => {
  if (canHover) return
  const all = resolvedSections.value
  if (all.length === 0) return
  modal.open(customModal || UiFootnoteModal, {
    props: all.length > 1
      ? { sections: all }
      : { modalTitle: all[0].title, text: all[0].text },
  })
}

const onMouseEnter = () => {
  if (canHover) {
    isVisible.value = true
    update()
  }
}

const onMouseLeave = () => {
  if (canHover) {
    isVisible.value = false
  }
}

onClickOutside(reference, () => {
  isVisible.value = false
})
</script>

<template>
  <div
    ref="reference"
    class="ui-footnote"
    @click.stop.prevent="onClick"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <SvgIcon
      class="ui-footnote__icon"
      :name="icon"
    />
    <Transition
      name="tooltip"
      @enter="update"
      @after-enter="update"
    >
      <div
        v-show="isVisible"
        ref="floating"
        :style="floatingStyles"
        class="ui-footnote__floating"
        @click.stop
      >
        <div class="ui-footnote__floating-content">
          <template
            v-for="(section, idx) in resolvedSections"
            :key="idx"
          >
            <div
              v-if="idx > 0"
              class="ui-footnote__floating-divider"
            />
            <div class="ui-footnote__floating-title">
              {{ section.title }}
            </div>
            <div class="ui-footnote__floating-text">
              {{ section.text }}
            </div>
          </template>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style lang="scss">
.ui-footnote {
  position: relative;
  width: 16px;
  height: 16px;
  cursor: pointer;
  transition: opacity 0.3s ease-in-out;

  &__icon {
    width: 16px;
    height: 16px;
    color: var(--ui-footnote-icon-color);
    transition: color 0.2s ease-in-out;
  }

  &__floating {
    position: relative;
    max-width: 400px;
    min-width: 200px;
    width: max-content;
    white-space: normal;
    padding: 16px;
    border-radius: 12px;
    background-color: var(--ui-footnote-floating-background-color);
    box-shadow: 0 8px 32px var(--ui-footnote-floating-box-shadow-color);
    z-index: 10;
  }

  &__floating-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    text-align: left;
  }

  &__floating-title {
    font-weight: 600;
    font-size: 14px;
    line-height: 20px;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  &__floating-text {
    font-weight: 400;
    font-size: 14px;
    line-height: 20px;
    word-wrap: break-word;
    overflow-wrap: break-word;
    hyphens: none;
  }

  &__floating-divider {
    height: 1px;
    background-color: var(--line-subtle);
    margin: 8px 0;
  }

}
</style>
