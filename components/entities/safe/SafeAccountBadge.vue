<script setup lang="ts">
const { address } = defineProps<{ address: string }>()

const { safeInfo } = useSafeAddressInfo(() => address)

// Describes the configured owner threshold only — enabled Safe modules can
// execute without owner confirmations, and the probe does not inspect them.
const tooltipText = computed(() => {
  if (!safeInfo.value) return ''
  const { threshold, owners, version } = safeInfo.value
  return `This address is a Safe smart account (v${version}) configured with a ${threshold}-of-${owners.length} owner threshold.`
})

const ariaLabel = computed(() => {
  if (!safeInfo.value) return 'Safe multisig'
  const { threshold, owners } = safeInfo.value
  return `Safe multisig: ${threshold} of ${owners.length} owner threshold`
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="safeInfo"
    title="Safe multisig"
    :text="tooltipText"
    :aria-label="ariaLabel"
  >
    <span class="flex items-center gap-4 text-content-secondary">
      <SvgIcon
        class="!w-14 !h-14"
        name="safe"
      />
      <span class="text-p5">({{ safeInfo.threshold }}/{{ safeInfo.owners.length }})</span>
    </span>
  </UiHoverPreviewTooltip>
</template>
