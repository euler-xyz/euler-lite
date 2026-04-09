<script setup lang="ts">
import { onClickOutside, useWindowSize } from '@vueuse/core'
import { flip, offset, shift, useFloating, type AlignedPlacement } from '@floating-ui/vue'
import { useModal } from '~/components/ui/composables/useModal'
import { UiFootnoteModal } from '#components'

const { title, text, tooltipPlacement = 'top-start', customModal, icon = 'info-circle' } = defineProps<{
  title: string
  text: string
  tooltipPlacement?: AlignedPlacement
  customModal?: Component
  icon?: string
}>()

const reference = ref(null)
const floating = ref(null)
const isVisible = ref(false)

const modal = useModal()
const { width } = useWindowSize()
const { floatingStyles, update } = useFloating(reference, floating, {
  placement: tooltipPlacement,
  middleware: [
    offset({ mainAxis: 15, crossAxis: -15 }),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
  ],
})

const onClick = () => {
  if (width.value < 768) {
    modal.open(customModal || UiFootnoteModal, {
      props: {
        modalTitle: title,
        text,
      },
    })
  }
  else {
    isVisible.value = !isVisible.value
    update()
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
          <div class="ui-footnote__floating-title">
            {{ title }}
          </div>
          <div class="ui-footnote__floating-text">
            {{ text }}
          </div>
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
    max-width: calc(800px / 2);
    min-width: 200px;
    width: max-content;
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
  }

  &__floating-title {
    font-weight: 600;
    font-size: 14px;
    line-height: 20px;
    white-space: nowrap;
  }

  &__floating-text {
    font-weight: 400;
    font-size: 14px;
    line-height: 20px;
    word-wrap: break-word;
    overflow-wrap: break-word;
    hyphens: auto;
  }

}
</style>
