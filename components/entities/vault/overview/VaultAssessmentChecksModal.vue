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
import { getRelativeTimeBetweenDates } from '~/utils/time-utils'

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
const groups = computed(() => groupVaultCheckFindings(details.value.findings).map(group => ({
  ...group,
  rows: group.findings.map((finding) => {
    const impact = getVaultCheckListingImpact(finding)
    return {
      finding,
      address: finding.key.match(/0x[a-fA-F0-9]{40}/)?.[0],
      title: getVaultCheckTitle(finding.key),
      tone: getVaultCheckFindingTone(finding),
      icon: iconFor(finding),
      parts: messagePartsFor(finding),
      listingImpact: impact ? VAULT_CHECK_LISTING_IMPACT_LABELS[impact] : null,
    }
  }),
})))

const { ensureResolved } = useVaultReferences()
watch(groups, (list) => {
  ensureResolved(list.flatMap(group => group.rows.map(row => ({ key: row.finding.key, parts: row.parts }))))
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
        v-if="!groups.length"
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
        <div
          v-for="(row, index) in group.rows"
          :key="`${row.finding.key}-${index}`"
          class="flex items-start gap-10"
          data-id="vault-check-finding"
          :data-key="row.finding.key"
        >
          <span
            class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-2"
            :class="{
              'bg-success-500': row.tone === 'pass',
              'bg-warning-500': row.tone === 'warning',
              'bg-error-500': row.tone === 'error',
              'bg-content-muted': row.tone === 'muted',
            }"
            :data-tone="row.tone"
          >
            <SvgIcon
              :name="row.icon"
              class="!w-10 !h-10 text-white"
            />
          </span>
          <div class="min-w-0">
            <p class="text-p3 font-medium text-content-primary break-words">
              <template v-if="row.address">
                <VaultReference
                  class="font-normal text-accent-600"
                  :address="row.address"
                />
                ·
              </template>{{ row.title }}
              <span
                v-if="row.finding.outcome === 'fail' && row.finding.exempted"
                class="ml-4 text-p4 font-normal text-content-tertiary"
              >Accepted exception</span>
              <span
                v-else-if="row.finding.outcome === 'not_applicable'"
                class="ml-4 text-p4 font-normal text-content-tertiary"
              >N/A</span>
              <span
                v-else-if="row.listingImpact"
                class="ml-4 text-p4 font-normal text-content-tertiary"
                data-id="vault-check-listing-impact"
              >{{ row.listingImpact }}</span>
            </p>
            <p
              v-if="row.parts.length"
              class="text-p3 text-content-secondary break-words"
            >
              <template
                v-for="(part, partIndex) in row.parts"
                :key="partIndex"
              >
                <VaultReference
                  v-if="part.address"
                  class="text-accent-600"
                  :address="part.address"
                  :fallback="part.text"
                />
                <template v-else>
                  {{ part.text }}
                </template>
              </template>
            </p>
          </div>
        </div>
      </section>
    </div>
  </BaseModalWrapper>
</template>
