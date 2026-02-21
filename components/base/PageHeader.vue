<script setup lang="ts">
defineProps({
  title: {
    type: String,
    default: '',
  },
  icon: {
    type: String,
    default: '',
  },
  arrowDown: Boolean,
  arrowRight: Boolean,
})
</script>

<template>
  <div class="mb-24 animate-fade-in-up">
    <!-- Row 1: icon + title -->
    <div class="flex items-center gap-12 mb-12">
      <SvgIcon
        :name="icon || 'arrow-big'"
        class="text-accent-600 !w-20 !h-20 shrink-0"
        :class="[
          !icon && arrowRight ? '-rotate-90' : '',
          !icon && arrowDown && !arrowRight ? 'rotate-0' : '',
          !icon && !arrowDown && !arrowRight ? 'rotate-180' : '',
        ]"
      />
      <h1 class="text-h3 text-content-primary">
        {{ title }}
      </h1>
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
