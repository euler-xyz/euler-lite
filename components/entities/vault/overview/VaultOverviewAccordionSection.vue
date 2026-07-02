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

  const sections = Array.from(parentEl.querySelectorAll<HTMLElement>(':scope > [data-vault-overview-accordion-section]'))
  if (sections.length === 1) {
    isOpen.value = true
    return
  }

  const collapsedSections = sections.filter(section =>
    section.querySelector('button[aria-expanded="false"]'),
  )
  if (collapsedSections.length === 1 && collapsedSections[0] === sectionEl.value) {
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
    <div
      class="group relative flex items-center gap-16 p-24"
      :data-open="isOpen ? 'true' : undefined"
    >
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 top-0 bottom-0 z-0 rounded-xl transition-colors group-hover:bg-card-hover group-data-[open=true]:bottom-8"
      />
      <button
        type="button"
        class="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
        :aria-expanded="isOpen"
        :aria-controls="panelId"
        :aria-label="`${isOpen ? 'Collapse' : 'Expand'} ${title}`"
        @click="toggle"
      />
      <span class="pointer-events-none relative z-10 min-w-0 flex-1 text-h3 text-content-primary transition-colors group-hover:text-accent-500">
        {{ title }}
      </span>
      <div
        v-if="$slots.actions && hasActions"
        class="relative z-20 shrink-0"
        @click.stop
      >
        <slot name="actions" />
      </div>
      <SvgIcon
        name="arrow-down"
        class="pointer-events-none relative z-10 !w-20 !h-20 shrink-0 text-content-tertiary transition-transform group-hover:text-content-secondary"
        :class="{ 'rotate-180': isOpen }"
        aria-hidden="true"
      />
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
