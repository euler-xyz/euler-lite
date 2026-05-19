<script setup lang="ts">
import type { Component } from 'vue'
import { type ModalData, useModal } from './composables/useModal'

const modal = useModal()
const { id = 0, data } = defineProps<{ id?: number, component: Component, data: ModalData }>()

const isComponentVisible = ref(false)
const isPreventClose = ref(false)

const styles = computed(() => {
  return {
    zIndex: data.zIndex,
    top: data.top || 0,
    bottom: data.top || 0,
    height: data.height || 'auto',
    position: data.position || 'fixed',
  }
})

const close = () => {
  if (isPreventClose.value) {
    return
  }

  if (data.onClose) {
    data.onClose()
  }
  else if (data.props?.onClose) {
    data.props.onClose()
  }

  isComponentVisible.value = false
}
const onClickWrapper = () => {
  if (!data.isNotClosable) {
    close()
  }
}
const beforeComponentLeave = () => {
  modal.close(id)

  if (data.beforeComponentLeave) {
    data.beforeComponentLeave()
  }
}
const handlePreventClose = (value: boolean) => {
  isPreventClose.value = value
}

onMounted(() => {
  isComponentVisible.value = true
})

onBeforeUnmount(() => {
  isComponentVisible.value = false
})
</script>

<template>
  <div
    class="ui-modal"
    :style="styles"
  >
    <Transition
      name="modal-panel"
      mode="out-in"
      appear
      @after-leave="beforeComponentLeave"
    >
      <div
        v-if="isComponentVisible"
        class="ui-modal__wrapper"
        @click.self="onClickWrapper"
      >
        <div
          class="ui-modal__panel-motion"
          @click.self="onClickWrapper"
        >
          <component
            :is="component"
            v-bind="data.props"
            :modal-id="id"
            @prevent-close="handlePreventClose"
            @close="close"
          />
        </div>
      </div>
    </Transition>
  </div>
</template>

<style lang="scss">
.ui-modal {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 3000;
  display: flex;
  background-color: rgba(0, 0, 0, 0.6);
  transform: translate3d(0, 0, 0);

  &__wrapper {
    display: flex;
    width: 100%;
    height: 100%;
    position: relative;
    margin: 0 auto;
  }

  &__panel-motion {
    position: relative;
    width: 100%;
    height: 100%;
  }
}
</style>
