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
  <div class="bg-surface border border-line-default rounded-xl mb-24 animate-fade-in-up overflow-hidden">
    <!-- Top section: icon + title -->
    <div class="flex items-center px-16 py-16">
      <div
        class="w-[52px] h-[52px] rounded-[14px] mr-16 bg-gradient-to-br from-accent-300/30 to-accent-400/40 flex items-center justify-center text-accent-600 flex-shrink-0 shadow-sm"
        :class="[
          !icon && arrowRight ? '[&>svg]:-rotate-90' : '',
          !icon && arrowDown && !arrowRight ? '[&>svg]:rotate-0' : '',
          !icon && !arrowDown && !arrowRight ? '[&>svg]:rotate-180' : '',
        ]"
      >
        <SvgIcon
          :name="icon || 'arrow-big'"
          :class="icon ? '!w-28 !h-28' : ''"
        />
      </div>
      <h1 class="text-h3 text-content-primary">
        {{ title }}
      </h1>
    </div>

    <!-- Divider -->
    <div class="border-t border-line-default" />

    <!-- Toolbar slot: search + filters -->
    <div class="flex items-center gap-8 px-16 py-12 overflow-x-auto">
      <slot name="toolbar" />
    </div>
  </div>
</template>
