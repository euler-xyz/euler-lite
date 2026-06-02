<script setup lang="ts">
const isTooltipEnabled = ref(false)
const showTooltip = ref(false)
let tooltipTimeout: ReturnType<typeof setTimeout> | undefined
let mobileQuery: MediaQueryList | undefined

const updateTooltipAvailability = () => {
  isTooltipEnabled.value = Boolean(mobileQuery?.matches)
  if (!isTooltipEnabled.value) showTooltip.value = false
}

const toggleTooltip = () => {
  showTooltip.value = !showTooltip.value
  if (tooltipTimeout) clearTimeout(tooltipTimeout)
  if (showTooltip.value) {
    tooltipTimeout = setTimeout(() => {
      showTooltip.value = false
    }, 1800)
  }
}

const onActivate = (event: MouseEvent | KeyboardEvent) => {
  if (!isTooltipEnabled.value) return
  event.preventDefault()
  event.stopPropagation()
  toggleTooltip()
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 900px)')
  updateTooltipAvailability()
  mobileQuery.addEventListener('change', updateTooltipAvailability)
})

onBeforeUnmount(() => {
  if (tooltipTimeout) clearTimeout(tooltipTimeout)
  mobileQuery?.removeEventListener('change', updateTooltipAvailability)
})
</script>

<template>
  <span
    class="recently-added-badge relative inline-flex items-center gap-4 rounded-8 px-8 py-2 text-p5 mobile:gap-0 mobile:rounded-full mobile:w-26 mobile:h-26 mobile:p-0 mobile:justify-center"
    :role="isTooltipEnabled ? 'button' : undefined"
    :tabindex="isTooltipEnabled ? 0 : undefined"
    title="Recently added vault"
    @click="onActivate"
    @keydown.enter="onActivate"
    @keydown.space="onActivate"
  >
    <SvgIcon
      name="star"
      class="!w-14 !h-14"
    />
    <span class="mobile:hidden">Recently added</span>
    <span
      v-if="showTooltip"
      class="hidden mobile:block absolute left-1/2 bottom-full mb-8 -translate-x-1/2 whitespace-nowrap rounded-8 bg-surface-secondary border border-line-default px-8 py-4 text-p5 text-content-primary shadow-card z-10"
    >
      Recently added
    </span>
  </span>
</template>

<style scoped lang="scss">
.recently-added-badge {
  border: 1px solid rgba(34, 211, 160, 0.28);
  color: #22d3a0;
  background-color: rgba(34, 211, 160, 0.08);
  transition: background-color 120ms ease, border-color 120ms ease;

  @media (max-width: 900px) {
    cursor: pointer;
  }
}
</style>
