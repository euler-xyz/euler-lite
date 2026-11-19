<script setup lang="ts">
const { size = '20' } = defineProps<{
  size?: '16' | '20' | '36' | '38' | '40' | '46'
}>()

const boxStyle = computed(() => ({ width: `${size}px`, height: `${size}px` }))
const iconStyle = computed(() => {
  const px = `${Math.round(Number(size) * 0.65)}px`
  return { width: px, height: px }
})
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full bg-warning-100 text-warning-500"
    :style="boxStyle"
    data-id="exposure-uncovered-icon"
  >
    <SvgIcon
      name="warning"
      :style="iconStyle"
    />
  </span>
</template>
