<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import {
  getAcceptedVaultCheckFindings,
  getVaultCheckFindings,
  getVaultChecksStatusLine,
} from '~/utils/vault-assessment/presentation'

const props = withDefaults(defineProps<{
  address: string
  chainId: number
  family?: VaultAssessmentFamily
  label?: string
}>(), { family: 'evk', label: 'Checks' })

const {
  isReady, source, loadError, visibility, vaultAssessments,
  getVaultAssessmentEntry, loadVaultAssessment, isVaultAssessmentAvailableForChain,
} = useEulerLabels()
const canShow = computed(() => isReady.value && source.value === 'v3'
  && isVaultAssessmentAvailableForChain(props.chainId))
const entry = computed(() => {
  void vaultAssessments.value
  return getVaultAssessmentEntry(props.chainId, props.address, props.family)
})
const assessment = computed(() => loadError.value ? undefined : entry.value.assessment)
const active = computed(() => assessment.value ? getVaultCheckFindings(assessment.value) : null)
const accepted = computed(() => assessment.value ? getAcceptedVaultCheckFindings(assessment.value) : [])
const statusLine = computed(() => getVaultChecksStatusLine(
  assessment.value,
  loadError.value ? 'unavailable' : entry.value.status,
))
const verdict = computed(() => visibility.value?.[props.address.toLowerCase()])
const status = computed(() => {
  if (statusLine.value === 'Checks unavailable') return { text: 'Unavailable', color: 'text-content-tertiary', dot: 'bg-content-muted' }
  if (!statusLine.value) return { text: 'Checking…', color: 'text-content-tertiary', dot: 'bg-content-muted' }
  if (statusLine.value.startsWith('Flagged')) return { text: 'Review', color: 'text-warning-500', dot: 'bg-warning-500' }
  if (accepted.value.length && statusLine.value.startsWith('Verified')) {
    const count = accepted.value.length
    return { text: `${count} accepted exception${count === 1 ? '' : 's'}`, color: 'text-content-secondary', dot: 'bg-content-muted' }
  }
  if (statusLine.value.startsWith('Verified')) return { text: 'Verified', color: 'text-success-500', dot: 'bg-success-500' }
  return { text: statusLine.value, color: 'text-content-tertiary', dot: 'bg-content-muted' }
})
const tooltipText = computed(() => {
  if (active.value?.reviewCount) {
    const lines = active.value.lines.map(finding => `• ${finding.text}`)
    if (active.value.moreCount) lines.push(`• ${active.value.moreCount} more checks to review`)
    return lines.join('\n') || verdict.value?.reason || statusLine.value
  }
  if (accepted.value.length && statusLine.value.startsWith('Verified')) {
    return `Configuration checks passed. These findings were accepted as exceptions:\n${accepted.value.map(finding => `• ${finding.text}`).join('\n')}`
  }
  if (statusLine.value.startsWith('Verified')) return 'Required configuration checks passed. This is not an overall risk rating.'
  return verdict.value?.reason || statusLine.value || 'Loading vault checks…'
})

watch(
  () => [canShow.value, props.chainId, props.address, props.family, loadError.value] as const,
  ([enabled, chainId, address, family, error]) => {
    if (enabled && !error && entry.value.status === 'idle') void loadVaultAssessment(chainId, address, family)
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="canShow"
    class="flex items-center gap-8 text-p3"
    data-id="vault-assessment-checks-field"
    :data-vault-address="address.toLowerCase()"
  >
    <span class="text-content-tertiary">{{ label }}</span>
    <UiHoverPreviewTooltip
      title="Vault checks"
      :text="tooltipText"
      :aria-label="`${label}: ${status.text}`"
      placement="top-start"
    >
      <span
        class="inline-flex items-center gap-5 cursor-help"
        :class="status.color"
        @click.stop.prevent
      >
        <span
          class="h-6 w-6 rounded-full"
          :class="status.dot"
          aria-hidden="true"
        />
        {{ status.text }}
        <SvgIcon
          name="info-circle"
          class="!w-14 !h-14"
        />
      </span>
    </UiHoverPreviewTooltip>
  </div>
</template>
