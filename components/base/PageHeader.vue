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
    <!-- Row 1: icon + title + search -->
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
      <div class="flex-1" />
      <slot name="search" />
    </div>

    <!-- Row 2: filters -->
    <div class="flex items-center gap-8 overflow-x-auto pb-2">
      <slot name="filters" />
    </div>
  </div>
</template>
