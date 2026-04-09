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
  icon: {
    type: String,
    default: '',
  },
  arrowDown: Boolean,
  arrowRight: Boolean,
})
</script>

<template>
  <div class="flex items-center animate-fade-in-up">
    <div
      class="w-[64px] h-[64px] rounded-[16px] mr-16 bg-gradient-to-br from-accent-300/30 to-accent-400/40 flex items-center justify-center text-accent-600 flex-shrink-0 shadow-sm"
      :class="[
        !icon && arrowRight ? '[&>svg]:-rotate-90' : '',
        !icon && arrowDown && !arrowRight ? '[&>svg]:rotate-0' : '',
        !icon && !arrowDown && !arrowRight ? '[&>svg]:rotate-180' : '',
      ]"
    >
      <SvgIcon
        :name="icon || 'arrow-big'"
        :class="icon ? '!w-40 !h-40' : '!w-36 !h-36'"
      />
    </div>
    <div>
      <h1 class="text-h2 mb-4 text-content-primary">
        {{ title }}
      </h1>
      <p class="text-content-tertiary text-lg">
        {{ description }}
      </p>
    </div>
  </div>
</template>
