<script setup lang="ts">
import { getChainPolicyGeneration } from '~/composables/useChainConfig'
import { isEVault, isEulerEarn, type VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { isVaultExitPaused } from '~/utils/vault-hooks'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { hasOnlyAcceptedVaultCheckFindings } from '~/utils/vault-assessment/presentation'
import {
  FLAGGED_VAULT_LABEL,
  FLAGGED_VAULT_TITLE,
  PAIR_SIDE_BADGE_LABELS,
  PAUSED_VAULT_FALLBACK_REASON,
  PAUSED_VAULT_LABEL,
  PAUSED_VAULT_TITLE,
  getFlaggedVaultLine,
  isPausedVerdict,
  type VaultPairSide,
} from '~/utils/vault-assessment/flagged'

const { address, hideDeprecated = false, hideChecks = false, pairSide, family = 'evk' } = defineProps<{
  address: string
  hideDeprecated?: boolean
  hideChecks?: boolean
  pairSide?: VaultPairSide
  family?: VaultAssessmentFamily | null
}>()

const { chainId } = useEulerAddresses()
const { isReady, source, visibility, vaultAssessments, getVaultAssessmentEntry, loadVaultAssessment } = useEulerLabels()
const { get: registryGet } = useVaultRegistry()
const verdict = computed(() => isReady.value && source.value === 'v3'
  ? visibility.value?.[address.toLowerCase()]
  : undefined)
const assessmentEntry = computed(() => {
  void vaultAssessments.value
  return chainId.value && family ? getVaultAssessmentEntry(chainId.value, address, family) : { status: 'idle' as const }
})
const registryVault = computed(() => registryGet(address)?.vault)
// Securitize vaults pass no family but are assessed on the EVK route, which carries their pause rule.
const pauseFamily = computed((): VaultAssessmentFamily | null => family === 'earn' || isEulerEarn(registryVault.value) ? null : 'evk')
const pauseEntry = computed(() => {
  void vaultAssessments.value
  return chainId.value && pauseFamily.value ? getVaultAssessmentEntry(chainId.value, address, pauseFamily.value) : { status: 'idle' as const }
})
const isOnchainPaused = computed(() => isEVault(registryVault.value) && isVaultExitPaused(registryVault.value))
const isPaused = computed(() => isPausedVerdict(verdict.value, {
  family: pauseFamily.value ? 'evk' : 'earn',
  onchainPaused: isOnchainPaused.value,
  assessment: pauseEntry.value.status === 'available' ? pauseEntry.value.assessment : undefined,
}))
watch(
  () => [chainId.value, address, pauseFamily.value, verdict.value?.status, verdict.value?.decidedBy, isOnchainPaused.value] as const,
  ([id, vaultAddress, selectedFamily, status, decidedBy, onchainPaused]) => {
    if (id && selectedFamily && !onchainPaused && status === 'hidden' && decidedBy?.startsWith('config-')
      && pauseEntry.value.status === 'idle') {
      void loadVaultAssessment(id, vaultAddress, selectedFamily)
    }
  },
  { immediate: true },
)
const acceptedOnly = computed(() => verdict.value?.status === 'warning' && verdict.value.decidedBy === 'advisories'
  && assessmentEntry.value.status === 'available'
  && !!assessmentEntry.value.assessment && hasOnlyAcceptedVaultCheckFindings(assessmentEntry.value.assessment))
watch(
  () => [chainId.value, address, family, verdict.value?.status, verdict.value?.decidedBy, hideChecks, getChainPolicyGeneration(chainId.value)] as const,
  ([id, vaultAddress, selectedFamily, status, decidedBy, suppressed]) => {
    if (id && selectedFamily && !suppressed && status === 'warning' && decidedBy === 'advisories' && assessmentEntry.value.status === 'idle') {
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
  if (isPaused.value) {
    return {
      title: PAUSED_VAULT_TITLE,
      description: verdict.value.reason || PAUSED_VAULT_FALLBACK_REASON,
    }
  }
  if (verdict.value.status === 'hidden') {
    return {
      title: FLAGGED_VAULT_TITLE,
      description: verdict.value.reason || getFlaggedVaultLine(null),
    }
  }
  return {
    title: 'Vault checks',
    description: verdict.value.reason || 'One or more vault checks need review.',
  }
})
const badgeLabel = computed(() => {
  const paused = isPaused.value
  const flagged = verdict.value?.status === 'hidden'
  if (pairSide) return PAIR_SIDE_BADGE_LABELS[pairSide][paused ? 'paused' : flagged ? 'flagged' : 'warning']
  if (verdict.value?.decidedBy === 'deprecated') return 'Deprecated'
  if (paused) return PAUSED_VAULT_LABEL
  return flagged ? FLAGGED_VAULT_LABEL : 'Warning'
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
      {{ badgeLabel }}
    </span>
  </UiHoverPreviewTooltip>
</template>
