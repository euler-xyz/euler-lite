<script setup lang="ts">
import { onClickOutside } from '@vueuse/core'

const { isOpen, close } = useSupportPanel()
const panelRef = ref(null)

onClickOutside(panelRef, () => {
  if (isOpen.value) close()
})

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && isOpen.value) close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="support-panel">
      <div
        v-if="isOpen"
        ref="panelRef"
        class="fixed right-24 bottom-24 z-[2900] mobile:inset-16"
        role="dialog"
        aria-label="Support"
      >
        <SupportPanel />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.support-panel-enter-active,
.support-panel-leave-active {
  transition: opacity var(--trs-fast), transform var(--trs-fast);
}

.support-panel-enter-from,
.support-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
