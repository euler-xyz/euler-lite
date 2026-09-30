<script setup lang="ts">
import type { AssessmentSafeEvidence } from '~/utils/vault-assessment/evidence'

const { address, evidence } = defineProps<{ address: string, evidence?: AssessmentSafeEvidence | null }>()

const { safeInfo: rpcSafeInfo } = useSafeAddressInfo(() => address, () => evidence === undefined)
const safeInfo = computed(() => evidence === undefined ? rpcSafeInfo.value : evidence)

// Describes the configured owner threshold only — enabled Safe modules can
// execute without owner confirmations, and the probe does not inspect them.
const tooltipText = computed(() => {
  if (!safeInfo.value) return ''
  const { threshold, owners } = safeInfo.value
  const version = 'version' in safeInfo.value ? ` (v${safeInfo.value.version})` : ''
  return `This address is a Safe smart account${version} configured with a ${threshold}-of-${owners.length} owner threshold.`
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
