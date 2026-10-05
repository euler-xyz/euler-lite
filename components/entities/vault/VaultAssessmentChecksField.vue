<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import {
  getVaultAssessmentCheckDetails,
  getVaultAssessmentCheckSummary,
  getVaultChecksStatusLine,
} from '~/utils/vault-assessment/presentation'
import { VaultAssessmentChecksModal } from '#components'

const props = withDefaults(defineProps<{
  address?: string
  addresses?: string[]
  chainId: number
  family?: VaultAssessmentFamily
  label?: string
}>(), { family: 'evk', label: 'Checks' })

const {
  isReady, source, visibility, vaultAssessments,
  getVaultAssessmentEntry, loadVaultAssessment, isVaultAssessmentAvailableForChain,
} = useEulerLabels()
const targets = computed(() => props.addresses ?? (props.address ? [props.address] : []))
const canShow = computed(() => targets.value.length > 0 && isReady.value && source.value === 'v3'
  && isVaultAssessmentAvailableForChain(props.chainId))
const entries = computed(() => {
  void vaultAssessments.value
  return targets.value.map(address => ({ address, entry: getVaultAssessmentEntry(props.chainId, address, props.family) }))
})
const single = computed(() => entries.value.length === 1 ? entries.value[0] : undefined)
const counts = computed(() => entries.value.reduce((sum, { entry }) => {
  if (entry.status !== 'available' || !entry.assessment?.assessed) return sum
  const { counts: own } = getVaultAssessmentCheckDetails(entry.assessment)
  return {
    passed: sum.passed + own.passed,
    failed: sum.failed + own.failed,
    unknown: sum.unknown + own.unknown,
    accepted: sum.accepted + own.accepted,
  }
}, { passed: 0, failed: 0, unknown: 0, accepted: 0 }))
const muted = (text: string) => ({ text, color: 'text-content-tertiary', dot: 'bg-content-muted' })
const status = computed(() => {
  if (entries.value.some(({ entry }) => entry.status === 'unavailable')) return muted('Unavailable')
  if (entries.value.some(({ entry }) => entry.status !== 'available')) return muted('Checking…')
  if (entries.value.some(({ entry }) => !entry.assessment?.assessed)) return muted('Not assessed yet')
  const { failed, unknown, accepted, passed } = counts.value
  if (failed) return { text: `${failed} failed`, color: 'text-warning-500', dot: 'bg-warning-500' }
  if (unknown) return muted(`${unknown} unknown`)
  if (accepted) return { text: `${accepted} accepted`, color: 'text-content-secondary', dot: 'bg-content-muted' }
  if (passed) return { text: `${passed} passed`, color: 'text-success-500', dot: 'bg-success-500' }
  return muted('No findings')
})
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const tooltipText = computed(() => {
  if (single.value) {
    const verdict = visibility.value?.[single.value.address.toLowerCase()]
    return verdict?.reason || getVaultChecksStatusLine(single.value.entry.assessment, single.value.entry.status) || 'Loading vault checks…'
  }
  return entries.value.map(({ address, entry }) => {
    const detail = entry.status === 'available' && entry.assessment?.assessed
      ? getVaultAssessmentCheckSummary(entry.assessment)
      : getVaultChecksStatusLine(entry.assessment, entry.status) || 'Loading…'
    return `${shortAddress(address)}: ${detail}`
  }).join('\n')
})

watch(
  () => [canShow.value, props.chainId, props.family, targets.value.join(',')] as const,
  ([enabled, chainId, family]) => {
    if (!enabled) return
    for (const { address, entry } of entries.value) {
      if (entry.status === 'idle') void loadVaultAssessment(chainId, address, family)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div
    v-if="canShow"
    class="flex items-center gap-8 text-p3"
    data-id="vault-assessment-checks-field"
    :data-vault-address="targets.map(address => address.toLowerCase()).join(',')"
  >
    <span class="text-content-tertiary">{{ label }}</span>
    <UiModalPreviewTrigger
      v-if="single?.entry.assessment?.assessed"
      :component="VaultAssessmentChecksModal"
      :modal-data="{ props: { assessment: single.entry.assessment } }"
      :aria-label="`${label}: ${status.text}`"
      placement="top-start"
      :clickable="false"
      popover-width="wide"
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
    </UiModalPreviewTrigger>
    <UiHoverPreviewTooltip
      v-else
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
