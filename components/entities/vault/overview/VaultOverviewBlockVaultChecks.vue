<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import {
  getAcceptedVaultCheckFindings,
  getNotListedLine,
  getUpcomingVaultChanges,
  getVaultCheckFindings,
  getVaultAssessmentCheckSummary,
  getVaultChecksStatusLine,
} from '~/utils/vault-assessment/presentation'
import { VaultAssessmentChecksModal } from '#components'

const props = defineProps<{
  address: string
  family?: VaultAssessmentFamily
  asset?: { decimals: number, symbol?: string }
  defaultOpen?: boolean
}>()
const { chainId } = useEulerAddresses()
const nowMs = useActivityNowMs()
const { isReady, loadError, source, visibility, vaultAssessments, loadVaultAssessment, getVaultAssessmentEntry, isVaultAssessmentAvailableForChain } = useEulerLabels()
const family = computed(() => props.family ?? 'evk')
const canShow = computed(() => !!chainId.value
  && source.value === 'v3'
  && isVaultAssessmentAvailableForChain(chainId.value))
const entry = computed(() => {
  // Track the reactive map while selecting the active chain and address.
  void vaultAssessments.value
  return chainId.value ? getVaultAssessmentEntry(chainId.value, props.address, family.value) : { status: 'idle' as const }
})
const assessment = computed(() => loadError.value ? undefined : entry.value.assessment)
const verdict = computed(() => isReady.value ? visibility.value?.[props.address.toLowerCase()] : undefined)
const findingView = computed(() => assessment.value ? getVaultCheckFindings(assessment.value) : null)
const acceptedFindings = computed(() => assessment.value ? getAcceptedVaultCheckFindings(assessment.value) : [])
const upcoming = computed(() => assessment.value ? getUpcomingVaultChanges(assessment.value, props.asset) : [])
const hasOracleAdapterFinding = computed(() => !!assessment.value?.configContext?.findings.some(
  finding => finding.key === 'oracle.adapters-recognized' && finding.outcome === 'fail' && !finding.exempted,
))
const notListed = computed(() => getNotListedLine(
  verdict.value?.status,
  verdict.value?.reason || assessment.value?.configReason || assessment.value?.consistencyReason,
  verdict.value?.decidedBy,
))
const statusLine = computed(() => getVaultChecksStatusLine(assessment.value, loadError.value ? 'unavailable' : entry.value.status, nowMs.value))
const checkSummary = computed(() => assessment.value ? getVaultAssessmentCheckSummary(assessment.value) : '')
const checkTone = computed(() => statusLine.value.startsWith('Flagged')
  ? 'bg-warning-500'
  : statusLine.value.startsWith('Checks passed') ? 'bg-success-500' : 'bg-content-muted')
const { isCopied, copyToClipboard } = useClipboardCopy()
const copyAddress = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

watch(
  () => [canShow.value, chainId.value, props.address, family.value, loadError.value] as const,
  ([enabled, id, address, selectedFamily, error]) => {
    if (enabled && id && !error) void loadVaultAssessment(id, address, selectedFamily)
  },
  { immediate: true },
)
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="canShow"
    title="Vault checks"
    :default-open="props.defaultOpen ?? false"
  >
    <div class="flex flex-col gap-12 rounded-xl border border-line-subtle bg-surface p-16 text-p3">
      <p
        v-if="notListed"
        class="text-content-tertiary"
        data-id="vault-not-listed"
      >
        {{ notListed }}
      </p>
      <div class="grid grid-cols-1 gap-12 sm:grid-cols-2">
        <div class="flex flex-col gap-4">
          <span class="text-content-tertiary">Status</span>
          <span
            :class="loadError || entry.status === 'unavailable' || statusLine === 'Not assessed yet' ? 'text-content-tertiary' : 'text-content-primary'"
            data-id="vault-checks-status"
          >{{ statusLine || 'Checking…' }}</span>
        </div>
        <UiModalPreviewTrigger
          v-if="assessment?.assessed && (assessment.configContext?.findings?.length || assessment.consistencyContext?.findings?.length)"
          class="flex min-w-0 flex-col gap-4 items-start cursor-default text-left"
          :component="VaultAssessmentChecksModal"
          :modal-data="{ props: { assessment } }"
          aria-label="Show all vault checks"
          placement="top-start"
          :clickable="false"
          popover-width="wide"
        >
          <span class="text-content-tertiary">Checks</span>
          <span class="flex min-w-0 items-center gap-6 text-content-primary">
            <span
              class="inline-block h-8 w-8 shrink-0 rounded-full"
              :class="checkTone"
            />
            {{ checkSummary }}
          </span>
        </UiModalPreviewTrigger>
        <div
          v-else
          class="flex flex-col gap-4"
        >
          <span class="text-content-tertiary">Checks</span>
          <span class="text-content-secondary">{{ statusLine || 'Checking…' }}</span>
        </div>
      </div>
      <ul
        v-if="findingView?.lines.length"
        class="flex flex-col gap-8"
      >
        <li
          v-for="finding in findingView.lines"
          :key="finding.key"
          class="flex gap-8"
          :class="finding.outcome === 'fail' ? 'text-warning-500' : 'text-content-tertiary'"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16 shrink-0 mt-2"
          />
          <span>
            <template v-if="finding.parts">
              <template
                v-for="(part, index) in finding.parts"
                :key="index"
              >
                <button
                  v-if="part.address"
                  type="button"
                  class="inline-flex items-center gap-2 align-baseline underline decoration-dotted outline-none hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
                  :title="isCopied(part.address) ? 'Copied' : 'Copy full address'"
                  :aria-label="`Copy address ${part.address}`"
                  @click.stop.prevent="copyAddress(part.address)"
                >
                  <span>{{ part.text }}</span>
                  <SvgIcon
                    class="!w-14 !h-14"
                    :name="isCopied(part.address) ? 'check' : 'copy'"
                  />
                </button>
                <template v-else>{{ part.text }}</template>
              </template>
            </template>
            <template v-else>{{ finding.text }}</template>
          </span>
        </li>
      </ul>
      <p
        v-if="findingView?.moreCount"
        class="text-content-tertiary"
      >
        {{ findingView.moreCount }} more not shown
      </p>
      <div
        v-if="acceptedFindings.length"
        class="flex flex-col gap-8 text-content-tertiary"
        data-id="vault-checks-accepted-exceptions"
      >
        <p class="font-medium text-content-secondary">
          Accepted exceptions
        </p>
        <p>These findings were accepted as exceptions and do not fail the configuration check.</p>
        <ul class="flex flex-col gap-8">
          <li
            v-for="finding in acceptedFindings"
            :key="finding.key"
            class="flex gap-8"
          >
            <SvgIcon
              name="info-circle"
              class="!w-16 !h-16 shrink-0 mt-2"
            />
            <span>
              <template v-if="finding.parts">
                <template
                  v-for="(part, index) in finding.parts"
                  :key="index"
                >
                  <button
                    v-if="part.address"
                    type="button"
                    class="inline-flex items-center gap-2 align-baseline underline decoration-dotted outline-none hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600"
                    :title="isCopied(part.address) ? 'Copied' : 'Copy full address'"
                    :aria-label="`Copy address ${part.address}`"
                    @click.stop.prevent="copyAddress(part.address)"
                  >
                    <span>{{ part.text }}</span>
                    <SvgIcon
                      class="!w-14 !h-14"
                      :name="isCopied(part.address) ? 'check' : 'copy'"
                    />
                  </button>
                  <template v-else>{{ part.text }}</template>
                </template>
              </template>
              <template v-else>{{ finding.text }}</template>
            </span>
          </li>
        </ul>
      </div>
      <p
        v-if="hasOracleAdapterFinding && !findingView?.lines.length && !findingView?.moreCount"
        class="text-content-tertiary"
      >
        Oracle adapter details are shown in Oracles.
      </p>
      <div
        v-if="upcoming.length"
        class="flex flex-col gap-8"
      >
        <h3 class="font-semibold text-content-primary">
          Upcoming changes
        </h3>
        <p
          v-for="change in upcoming"
          :key="change.key"
          :class="change.failing ? 'text-error-500' : 'text-content-tertiary'"
        >
          {{ change.text }}
        </p>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>
