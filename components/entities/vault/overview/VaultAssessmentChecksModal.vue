<script setup lang="ts">
import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import {
  VAULT_CHECKS_DISCLAIMER,
  VAULT_CHECK_LISTING_IMPACT_LABELS,
  getVaultAssessmentCheckDetails,
  getVaultCheckCopyableParts,
  getVaultCheckFindingTone,
  getVaultCheckListingImpact,
  getVaultCheckMessage,
  getVaultCheckTitle,
  groupVaultCheckFindings,
} from '~/utils/vault-assessment/presentation'
import { groupVaultCheckRows, type VaultCheckRowView, type VaultCheckView } from '~/utils/vault-assessment/check-rows'
import { getVaultCheckSubject, vaultCheckSubjectKey, type VaultCheckSubject } from '~/utils/vault-assessment/subjects'
import { getRelativeTimeBetweenDates } from '~/utils/time-utils'
import { formatUncoveredBorrows } from '~/composables/useVaultCheckWeights'

defineEmits(['close'])

const props = withDefaults(defineProps<{
  assessment: VaultAssessment
  inline?: boolean
  close?: boolean
}>(), { inline: false, close: true })

const details = computed(() => getVaultAssessmentCheckDetails(props.assessment))
const checkedAgo = computed(() => {
  const at = props.assessment.configLastCheckedAt
  if (!at || !Number.isFinite(Date.parse(at))) return null
  return getRelativeTimeBetweenDates(new Date(), new Date(at))
})
const iconFor = (finding: VaultAssessmentFinding) => {
  const tone = getVaultCheckFindingTone(finding)
  if (tone === 'pass') return 'check'
  if (tone === 'muted') return 'info-circle'
  return tone === 'error' && finding.outcome === 'fail' ? 'close' : 'warning'
}
const messagePartsFor = (finding: VaultAssessmentFinding) => {
  const message = getVaultCheckMessage(finding)
  if (!message) return []
  return getVaultCheckCopyableParts(message, finding) ?? [{ text: message, address: undefined }]
}
const tagFor = (finding: VaultAssessmentFinding): string | null => {
  if (finding.outcome === 'fail' && finding.exempted) return 'Accepted exception'
  if (finding.outcome === 'not_applicable') return 'N/A'
  const impact = getVaultCheckListingImpact(finding)
  return impact ? VAULT_CHECK_LISTING_IMPACT_LABELS[impact] : null
}
const statusFor = (finding: VaultAssessmentFinding): string => {
  if (finding.outcome === 'fail') return finding.exempted ? 'accepted exception' : 'failed'
  if (finding.outcome === 'unknown') return 'not checked yet'
  return finding.outcome === 'pass' ? 'passed' : 'not applicable'
}
const toCheckView = (finding: VaultAssessmentFinding): VaultCheckView => ({
  key: finding.key,
  title: getVaultCheckTitle(finding.key),
  status: statusFor(finding),
  tone: getVaultCheckFindingTone(finding),
  icon: iconFor(finding),
  parts: messagePartsFor(finding),
  tag: tagFor(finding),
})

const shownGroups = computed(() => groupVaultCheckFindings(details.value.findings))
const checkViews = computed(() => new Map(shownGroups.value.flatMap(group => group.findings.map(finding => [finding, toCheckView(finding)] as const))))

const { weighAll, getUncoveredBorrows } = useVaultCheckWeights(() => props.assessment.vaultAddress)
const uncoveredLine = computed(() => {
  const uncovered = getUncoveredBorrows()
  return uncovered ? formatUncoveredBorrows(uncovered) : null
})
const groups = computed(() => {
  const subjects = [...new Map(shownGroups.value
    .flatMap(group => group.findings.map(finding => getVaultCheckSubject(finding.key)))
    .filter((subject): subject is VaultCheckSubject => !!subject)
    .map(subject => [vaultCheckSubjectKey(subject), subject] as const)).values()]
  const measured = weighAll(subjects)
  const weights = new Map(subjects.map((subject, index) => [vaultCheckSubjectKey(subject), measured[index]]))
  const weightOf = (subject: VaultCheckSubject) => weights.get(vaultCheckSubjectKey(subject)) ?? null
  // Covered value cannot say which collateral carries bad debt, so it only ranks rows while there is none.
  const rankValueOf = (subject: VaultCheckSubject) => subject.namespace === 'collateral' && uncoveredLine.value ? null : weightOf(subject)?.value ?? null
  const collateralTitle = props.assessment.family === 'earn' ? 'Collateral in strategies' : 'Collateral'
  const groupsWithCollateral = uncoveredLine.value && !shownGroups.value.some(group => group.key === 'collateral')
    ? [...shownGroups.value, { key: 'collateral', title: collateralTitle, findings: [] }]
    : shownGroups.value
  return groupsWithCollateral.map(group => ({
    key: group.key,
    title: group.key === 'collateral' ? collateralTitle : group.title,
    note: group.key === 'collateral' ? uncoveredLine.value : null,
    rows: groupVaultCheckRows(group.findings, rankValueOf).map((row): VaultCheckRowView => ({
      key: row.key,
      subject: row.subject,
      weight: row.subject ? weightOf(row.subject)?.label ?? null : null,
      checks: row.findings.map(finding => checkViews.value.get(finding)!),
    })),
  }))
})

const { ensureResolved } = useVaultReferences()
watch(checkViews, (views) => {
  ensureResolved([...views.values()].map(check => ({ key: check.key, parts: check.parts })))
}, { immediate: true })
</script>

<template>
  <BaseModalWrapper
    title="Vault checks"
    :inline="inline"
    :close="close"
    :compact="inline && !close"
    @close="$emit('close')"
  >
    <div class="flex flex-col gap-10">
      <p
        v-if="checkedAgo"
        class="text-p4 text-content-tertiary"
      >
        Checked {{ checkedAgo }}
      </p>
      <p
        class="text-p4 text-content-tertiary"
        data-id="vault-checks-disclaimer"
      >
        {{ VAULT_CHECKS_DISCLAIMER }}
      </p>
      <p
        v-if="!shownGroups.length"
        class="text-p3 text-content-secondary"
      >
        No detailed findings are available yet.
      </p>
      <section
        v-for="group in groups"
        :key="group.key"
        class="flex flex-col gap-10 pt-4"
        data-id="vault-check-group"
        :data-group="group.key"
      >
        <h3 class="text-p3 font-semibold text-content-primary">
          {{ group.title }}
        </h3>
        <p
          v-if="group.note"
          class="text-p3 text-warning-500"
          data-id="vault-check-uncovered"
        >
          {{ group.note }}
        </p>
        <VaultAssessmentCheckRow
          v-for="row in group.rows"
          :key="row.key"
          :row="row"
        />
      </section>
    </div>
  </BaseModalWrapper>
</template>
