<script setup lang="ts">
const { address } = defineProps<{ address: string }>()

const { safeInfo } = useSafeAddressInfo(() => address)

const tooltipText = computed(() => {
  if (!safeInfo.value) return ''
  const { threshold, owners, version } = safeInfo.value
  return `This address is a Safe smart account (v${version}). Executing a transaction from it requires ${threshold} of its ${owners.length} owner signatures.`
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="safeInfo"
    title="Safe multisig"
    :text="tooltipText"
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
