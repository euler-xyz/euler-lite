<script setup lang="ts">
defineProps<{
  title: string
  icon: string
}>()
</script>

<template>
  <section class="min-w-0 rounded-12 bg-surface p-14 flex flex-col gap-14 border border-line-subtle">
    <div class="flex items-center gap-8">
      <span
        class="flex items-center justify-center w-24 h-24 rounded-8 bg-surface-secondary shrink-0"
        aria-hidden="true"
      >
        <SvgIcon
          :name="icon"
          class="!w-14 !h-14 text-content-secondary"
        />
      </span>
      <h4 class="text-p2 font-semibold text-content-primary">
        {{ title }}
      </h4>
    </div>
    <slot />
  </section>
</template>
