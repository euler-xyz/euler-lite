<script setup lang="ts">
defineProps({
  title: {
    type: String,
    default: '',
  },
  description: {
    type: String,
    default: '',
  },
})
</script>

<template>
  <div class="bg-surface-secondary rounded-t-6 border-b border-line-default p-20 pb-16 animate-fade-in-up">
    <!-- Row 1: title + description -->
    <div class="mb-16">
      <h1 class="text-h1 text-content-primary mb-8">
        {{ title }}
      </h1>
      <p
        v-if="description"
        class="text-[16px] font-medium text-content-tertiary"
      >
        {{ description }}
      </p>
    </div>

    <!-- Row 2: filters (scrollable) + search pinned right -->
    <div class="flex items-center gap-8">
      <div class="flex items-center gap-8 overflow-x-auto flex-1 pb-2">
        <slot name="filters" />
      </div>
      <div class="shrink-0 text-[14px]">
        <slot name="search" />
      </div>
    </div>
  </div>
</template>
