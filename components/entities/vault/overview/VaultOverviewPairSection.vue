<script setup lang="ts">
defineProps<{
  title: string
  icon: string
}>()
</script>

<template>
  <section class="min-w-0 rounded-12 bg-surface p-16 flex flex-col gap-16 shadow-sm">
    <div class="flex items-center gap-10">
      <span
        class="flex items-center justify-center w-28 h-28 rounded-8 bg-surface-secondary shrink-0"
        aria-hidden="true"
      >
        <SvgIcon
          :name="icon"
          class="!w-16 !h-16 text-content-secondary"
        />
      </span>
      <h4 class="text-p2 font-semibold text-content-primary">
        {{ title }}
      </h4>
    </div>
    <slot />
  </section>
</template>
