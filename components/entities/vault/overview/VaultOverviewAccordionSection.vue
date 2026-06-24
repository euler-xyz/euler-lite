<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  defaultOpen?: boolean
  contentClass?: string
  hasActions?: boolean
}>(), {
  defaultOpen: true,
  contentClass: 'flex flex-col gap-24',
  hasActions: true,
})

const isOpen = ref(props.defaultOpen)
const panelId = useId()
const sectionEl = ref<HTMLElement>()

const expandIfOnlySection = () => {
  const parentEl = sectionEl.value?.parentElement
  if (!parentEl) return

  const sectionCount = parentEl.querySelectorAll(':scope > [data-vault-overview-accordion-section]').length
  if (sectionCount === 1) {
    isOpen.value = true
  }
}

const toggle = () => {
  isOpen.value = !isOpen.value
}

onMounted(async () => {
  await nextTick()
  expandIfOnlySection()
})
</script>

<template>
  <section
    ref="sectionEl"
    class="bg-surface-secondary rounded-xl shadow-card"
    data-vault-overview-accordion-section
  >
    <div class="flex items-center gap-16 p-24">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center text-left transition-colors hover:text-accent-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-4 focus-visible:ring-offset-surface-secondary"
        :aria-expanded="isOpen"
        :aria-controls="panelId"
        @click="toggle"
      >
        <span class="text-h3 text-content-primary">
          {{ title }}
        </span>
      </button>
      <div
        v-if="$slots.actions && hasActions"
        class="shrink-0"
      >
        <slot name="actions" />
      </div>
      <button
        type="button"
        class="shrink-0 text-content-tertiary transition-colors hover:text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-4 focus-visible:ring-offset-surface-secondary"
        :aria-expanded="isOpen"
        :aria-controls="panelId"
        :aria-label="`${isOpen ? 'Collapse' : 'Expand'} ${title}`"
        @click="toggle"
      >
        <SvgIcon
          name="arrow-down"
          class="!w-20 !h-20 transition-transform"
          :class="{ 'rotate-180': isOpen }"
          aria-hidden="true"
        />
      </button>
    </div>

    <div
      v-if="isOpen"
      :id="panelId"
      class="px-24 pb-24"
    >
      <div :class="contentClass">
        <slot />
      </div>
    </div>
  </section>
</template>
