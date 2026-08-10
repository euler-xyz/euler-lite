<script setup lang="ts">
import { shortenAddress } from '~/utils/string-utils'

const { address } = defineProps<{ address: string }>()

const { safeInfo } = useSafeAddressInfo(() => address)

const tooltipSections = computed(() => {
  if (!safeInfo.value) return []
  const { threshold, owners, version } = safeInfo.value
  return [
    {
      title: `Safe smart account (v${version})`,
      text: `Executing a transaction from this address requires ${threshold} of its ${owners.length} owner signatures.`,
    },
    {
      title: `Owners (${owners.length})`,
      text: owners.map(owner => shortenAddress(owner)).join(', '),
    },
  ]
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="safeInfo"
    title="Safe multisig"
    :sections="tooltipSections"
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
