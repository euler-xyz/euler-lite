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

const toggle = () => {
  isOpen.value = !isOpen.value
}
</script>

<template>
  <section class="bg-surface-secondary rounded-xl shadow-card">
    <div class="flex items-center gap-16">
      <button
        type="button"
        class="flex min-w-0 items-center justify-between gap-16 text-left transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
        :class="$slots.actions && hasActions ? 'flex-1 p-24 pr-0' : 'w-full p-24'"
        :aria-expanded="isOpen"
        :aria-controls="panelId"
        @click="toggle"
      >
        <span class="text-h3 text-content-primary">
          {{ title }}
        </span>
        <SvgIcon
          name="arrow-down"
          class="!w-20 !h-20 shrink-0 text-content-tertiary transition-transform"
          :class="{ 'rotate-180': isOpen }"
          aria-hidden="true"
        />
      </button>
      <div
        v-if="$slots.actions && hasActions"
        class="shrink-0 pr-24"
      >
        <slot name="actions" />
      </div>
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
