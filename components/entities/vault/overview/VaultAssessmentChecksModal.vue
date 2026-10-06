<script setup lang="ts">
import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import { getVaultAssessmentCheckDetails, getVaultCheckCopyableParts, getVaultCheckFindingTone } from '~/utils/vault-assessment/presentation'
import { getRelativeTimeBetweenDates } from '~/utils/time-utils'
import { shortenAddress } from '~/utils/string-utils'

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
const titleFor = (finding: VaultAssessmentFinding) => {
  const parts = finding.key.split('.').filter(part => !/^0x[a-fA-F0-9]{40}$/.test(part))
  const suffix = (parts.at(-1) ?? finding.key).replaceAll('-', ' ')
  const label = finding.key.startsWith('collateral.') ? `Collateral ${suffix}` : suffix
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
    .replace(/\bapy\b/gi, 'APY').replace(/\bltv\b/gi, 'LTV')
    .replace(/\bevc\b/gi, 'EVC').replace(/\bevault\b/gi, 'EVault')
}
const addressFor = (finding: VaultAssessmentFinding) => finding.key.match(/0x[a-fA-F0-9]{40}/)?.[0]
const iconFor = (finding: VaultAssessmentFinding) => {
  const tone = getVaultCheckFindingTone(finding)
  if (tone === 'pass') return 'check'
  if (tone === 'muted') return 'info-circle'
  return tone === 'error' && finding.outcome === 'fail' ? 'close' : 'warning'
}
const messageFor = (finding: VaultAssessmentFinding) => finding.cause?.summary || finding.description
const messagePartsFor = (finding: VaultAssessmentFinding) =>
  getVaultCheckCopyableParts(messageFor(finding), finding) ?? [{ text: messageFor(finding), address: undefined }]
const { isCopied, copyToClipboard } = useClipboardCopy()
const copyAddress = (address: string) => {
  copyToClipboard(address).catch(() => {})
}
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
      <p class="text-p4 text-content-tertiary">
        Configuration checks are not an overall risk rating.
      </p>
      <p
        v-if="!details.findings.length"
        class="text-p3 text-content-secondary"
      >
        No detailed findings are available yet.
      </p>
      <div
        v-for="(finding, index) in details.findings"
        :key="`${finding.key}-${index}`"
        class="flex items-start gap-10"
      >
        <span
          class="flex-shrink-0 w-20 h-20 rounded-full flex items-center justify-center mt-8"
          :class="{
            'bg-success-500': getVaultCheckFindingTone(finding) === 'pass',
            'bg-warning-500': getVaultCheckFindingTone(finding) === 'warning',
            'bg-error-500': getVaultCheckFindingTone(finding) === 'error',
            'bg-content-muted': getVaultCheckFindingTone(finding) === 'muted',
          }"
          :data-tone="getVaultCheckFindingTone(finding)"
        >
          <SvgIcon
            :name="iconFor(finding)"
            class="!w-10 !h-10 text-white"
          />
        </span>
        <div class="min-w-0">
          <p class="text-p3 font-medium text-content-primary break-words">
            {{ titleFor(finding) }}
            <button
              v-if="addressFor(finding)"
              type="button"
              class="ml-4 inline-flex items-center gap-2 font-mono text-p4 font-normal text-accent-600 underline decoration-dotted outline-none hover:text-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
              :aria-label="`Copy address ${addressFor(finding)}`"
              @mousedown.stop.prevent
              @click.stop.prevent="copyAddress(addressFor(finding)!)"
            >
              {{ shortenAddress(addressFor(finding)) }}
              <SvgIcon
                class="!w-12 !h-12"
                :name="isCopied(addressFor(finding)!) ? 'check' : 'copy'"
              />
            </button>
            <span
              v-if="finding.outcome === 'fail' && finding.exempted"
              class="ml-4 text-p4 text-content-tertiary"
            >Accepted exception</span>
            <span
              v-else-if="finding.outcome === 'not_applicable'"
              class="ml-4 text-p4 text-content-tertiary"
            >N/A</span>
          </p>
          <p class="text-p3 text-content-secondary break-words">
            <template
              v-for="(part, partIndex) in messagePartsFor(finding)"
              :key="partIndex"
            >
              <button
                v-if="part.address"
                type="button"
                class="inline-flex items-center gap-2 font-mono text-accent-600 underline decoration-dotted outline-none hover:text-accent-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
                :aria-label="`Copy address ${part.address}`"
                @mousedown.stop.prevent
                @click.stop.prevent="copyAddress(part.address)"
              >
                {{ part.text }}
                <SvgIcon
                  class="!w-12 !h-12"
                  :name="isCopied(part.address) ? 'check' : 'copy'"
                />
              </button>
              <template v-else>
                {{ part.text }}
              </template>
            </template>
          </p>
          <p
            v-if="finding.cause?.summary && finding.description !== finding.cause.summary"
            class="text-p4 text-content-tertiary break-words"
          >
            {{ finding.description }}
          </p>
        </div>
      </div>
    </div>
  </BaseModalWrapper>
</template>
