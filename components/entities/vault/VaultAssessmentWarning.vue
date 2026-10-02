<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { hasOnlyAcceptedVaultCheckFindings } from '~/utils/vault-assessment/presentation'

const { address, hideDeprecated = false, hideChecks = false, badgeLabel, family = 'evk' } = defineProps<{
  address: string
  hideDeprecated?: boolean
  hideChecks?: boolean
  badgeLabel?: string
  family?: VaultAssessmentFamily | null
}>()

const { chainId } = useEulerAddresses()
const { isReady, source, visibility, loadError, vaultAssessments, getVaultAssessmentEntry, loadVaultAssessment } = useEulerLabels()
const verdict = computed(() => isReady.value && source.value === 'v3'
  ? visibility.value?.[address.toLowerCase()]
  : undefined)
const assessmentEntry = computed(() => {
  void vaultAssessments.value
  return chainId.value && family ? getVaultAssessmentEntry(chainId.value, address, family) : { status: 'idle' as const }
})
const acceptedOnly = computed(() => verdict.value?.status === 'warning' && verdict.value.decidedBy === 'advisories'
  && !loadError.value && assessmentEntry.value.status === 'available'
  && !!assessmentEntry.value.assessment && hasOnlyAcceptedVaultCheckFindings(assessmentEntry.value.assessment))
watch(
  () => [chainId.value, address, family, verdict.value?.status, verdict.value?.decidedBy, loadError.value, hideChecks] as const,
  ([id, vaultAddress, selectedFamily, status, decidedBy, error, suppressed]) => {
    if (id && selectedFamily && !error && !suppressed && status === 'warning' && decidedBy === 'advisories' && assessmentEntry.value.status === 'idle') {
      void loadVaultAssessment(id, vaultAddress, selectedFamily)
    }
  },
  { immediate: true },
)
const warning = computed(() => {
  if (acceptedOnly.value) return null
  if (verdict.value?.status !== 'warning' && verdict.value?.status !== 'hidden') return null
  if (hideChecks && verdict.value.status === 'warning') return null
  if (hideDeprecated && verdict.value.decidedBy === 'deprecated') return null

  if (verdict.value.decidedBy === 'deprecated') {
    return {
      title: 'Deprecated vault',
      description: verdict.value.reason || 'This vault has been deprecated.',
    }
  }
  if (verdict.value.decidedBy === 'unassessable') {
    return {
      title: 'Vault assessment incomplete',
      description: verdict.value.reason || 'Some checks could not be completed for this vault.',
    }
  }
  return {
    title: verdict.value.status === 'hidden' ? 'Vault not listed' : 'Vault checks',
    description: verdict.value.reason || (verdict.value.status === 'hidden'
      ? 'This vault is not listed.'
      : 'One or more vault checks need review.'),
  }
})
</script>

<template>
  <UiHoverPreviewTooltip
    v-if="warning"
    :title="warning.title"
    :text="warning.description"
    placement="top-start"
  >
    <span
      class="inline-flex items-center gap-4 rounded-8 bg-warning-100 px-8 py-2 text-p5 text-warning-500"
      data-id="vault-assessment-warning"
      :data-vault-address="address.toLowerCase()"
      :data-warning-reason="verdict?.decidedBy"
    >
      <SvgIcon
        name="warning"
        class="!h-14 !w-14"
      />
      {{ badgeLabel || (verdict?.decidedBy === 'deprecated' ? 'Deprecated' : verdict?.status === 'hidden' ? 'Not listed' : 'Vault checks') }}
    </span>
  </UiHoverPreviewTooltip>
</template>
