<script setup lang="ts">
const {
  title,
  full = false,
  close = true,
  warning = false,
} = defineProps<{
  title?: string
  full?: boolean
  close?: boolean
  warning?: boolean
}>()
defineEmits(['close'])
</script>

<template>
  <div
    class="flex flex-col absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-16 min-w-[min(375px,100vw)] max-w-[600px] overflow-auto [scrollbar-width:none] max-h-[85dvh] rounded-16 mobile:top-auto mobile:left-0 mobile:bottom-0 mobile:w-full mobile:min-w-full mobile:max-h-[95dvh] mobile:translate-x-0 mobile:translate-y-0 mobile:rounded-t-16 mobile:rounded-b-0 bg-euler-dark-500 [&::-webkit-scrollbar]:hidden"
    :class="[full ? 'min-h-[85dvh] mobile:min-h-[95dvh]' : '']"
  >
    <div
      v-if="title || close"
      class="flex justify-between mb-12 items-center h-36"
    >
      <p
        v-if="title"
        class="flex text-h4 items-center gap-8"
      >
        <SvgIcon
          v-if="warning"
          name="warning"
          class="!w-20 !h-20 text-warning-500"
        />
        {{ title }}
      </p>
      <UiButton
        v-if="close"
        variant="primary-stroke"
        icon="close"
        name="cross"
        icon-only
        @click="$emit('close')"
      />
    </div>

    <div
      class="flex flex-col"
      :class="[full ? 'flex-grow' : '']"
    >
      <slot />
    </div>

    <slot name="bottom" />
  </div>
</template>
