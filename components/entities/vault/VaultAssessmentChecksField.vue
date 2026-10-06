<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { getVaultChecksCell, getVaultChecksStatusLine } from '~/utils/vault-assessment/presentation'
import { VaultAssessmentChecksModal } from '#components'

const props = withDefaults(defineProps<{
  address: string
  chainId: number
  family?: VaultAssessmentFamily
  label?: string
  /** The vault is unknown to the app, so a failing check is an error, not a warning. */
  errorTone?: boolean
}>(), { family: 'evk', label: 'Checks', errorTone: false })

const {
  isReady, source, visibility, vaultAssessments,
  getVaultAssessmentEntry, loadVaultAssessment, isVaultAssessmentAvailableForChain,
} = useEulerLabels()
const canShow = computed(() => isReady.value && source.value === 'v3' && isVaultAssessmentAvailableForChain(props.chainId))
const entry = computed(() => {
  void vaultAssessments.value
  return getVaultAssessmentEntry(props.chainId, props.address, props.family)
})
const tones = {
  positive: { color: 'text-success-500', dot: 'bg-success-500' },
  warning: { color: 'text-warning-500', dot: 'bg-warning-500' },
  error: { color: 'text-error-500', dot: 'bg-error-500' },
  muted: { color: 'text-content-tertiary', dot: 'bg-content-muted' },
} as const
const status = computed(() => {
  if (entry.value.status === 'unavailable') return { text: 'Unavailable', ...tones.muted }
  if (entry.value.status !== 'available' || !entry.value.assessment) return { text: 'Checking…', ...tones.muted }
  const cell = getVaultChecksCell(entry.value.assessment)
  const tone = cell.tone === 'warning' && props.errorTone ? 'error' : cell.tone
  return { text: cell.text, ...tones[tone] }
})
const tooltipText = computed(() => visibility.value?.[props.address.toLowerCase()]?.reason
  || getVaultChecksStatusLine(entry.value.assessment, entry.value.status)
  || 'Loading vault checks…')

watch(
  () => [canShow.value, props.chainId, props.address, props.family] as const,
  ([enabled, chainId, address, family]) => {
    if (enabled && entry.value.status === 'idle') void loadVaultAssessment(chainId, address, family)
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="canShow"
    class="flex flex-col"
    data-id="vault-assessment-checks-field"
    :data-vault-address="address.toLowerCase()"
  >
    <div class="text-content-tertiary text-p3 mb-4 whitespace-nowrap">
      {{ label }}
    </div>
    <UiModalPreviewTrigger
      v-if="entry.assessment?.assessed"
      :component="VaultAssessmentChecksModal"
      :modal-data="{ props: { assessment: entry.assessment } }"
      :aria-label="`${label}: ${status.text}`"
      placement="top-start"
      :clickable="false"
      popover-width="wide"
    >
      <span
        class="inline-flex items-center gap-6 cursor-help text-p2 whitespace-nowrap"
        :class="status.color"
        @click.stop.prevent
      >
        <span
          class="h-6 w-6 rounded-full"
          :class="status.dot"
          aria-hidden="true"
        />
        {{ status.text }}
      </span>
    </UiModalPreviewTrigger>
    <UiHoverPreviewTooltip
      v-else
      title="Vault checks"
      :text="tooltipText"
      :aria-label="`${label}: ${status.text}`"
      placement="top-start"
    >
      <span
        class="inline-flex items-center gap-6 cursor-help text-p2 whitespace-nowrap"
        :class="status.color"
        @click.stop.prevent
      >
        <span
          class="h-6 w-6 rounded-full"
          :class="status.dot"
          aria-hidden="true"
        />
        {{ status.text }}
      </span>
    </UiHoverPreviewTooltip>
  </div>
</template>
