<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import {
  getUpcomingVaultChanges,
  getVaultCheckWarningLines,
  getVaultChecksCell,
  getVaultChecksStatusLine,
  getWarningAdapterFailures,
} from '~/utils/vault-assessment/presentation'
import { getExplorerLink } from '~/utils/block-explorer'
import { shortenAddress } from '~/utils/string-utils'
import { VaultAssessmentChecksModal } from '#components'

const props = defineProps<{
  address: string
  family?: VaultAssessmentFamily
  asset?: { decimals: number, symbol?: string }
  symbol?: string
}>()
const { chainId } = useEulerAddresses()
const nowMs = useActivityNowMs()
const { vaultAssessments, loadVaultAssessment, getVaultAssessmentEntry, oracleAdapters, loadOracleAdapters } = useEulerLabels()
const adapterLabel = (address: string) => {
  const meta = oracleAdapters[address.toLowerCase()]
  return meta?.label || meta?.name || undefined
}
const family = computed(() => props.family ?? 'evk')
const entry = computed(() => {
  void vaultAssessments.value
  return chainId.value ? getVaultAssessmentEntry(chainId.value, props.address, family.value) : { status: 'idle' as const }
})
const assessment = computed(() => entry.value.assessment)
const lines = computed(() => assessment.value ? getVaultCheckWarningLines(assessment.value, { adapterLabel }) : [])
const warningAdapters = computed(() => {
  const findings = [...(assessment.value?.configContext?.findings ?? []), ...(assessment.value?.consistencyContext?.findings ?? [])]
  return findings.flatMap(finding => getWarningAdapterFailures(finding).map(failure => failure.address))
})
watch([warningAdapters, chainId], ([addresses, id]) => {
  const missing = addresses.filter(address => !oracleAdapters[address.toLowerCase()])
  if (id && missing.length) void loadOracleAdapters(id, missing)
}, { immediate: true })
const upcoming = computed(() => assessment.value ? getUpcomingVaultChanges(assessment.value, props.asset) : [])
const statusLine = computed(() => getVaultChecksStatusLine(assessment.value, entry.value.status, nowMs.value))
const hasFindings = computed(() => !!assessment.value?.assessed
  && !!(assessment.value.configContext?.findings?.length || assessment.value.consistencyContext?.findings?.length))
const cell = computed(() => assessment.value?.assessed ? getVaultChecksCell(assessment.value) : null)
const toneClass = { positive: 'bg-success-500', warning: 'bg-warning-500', muted: 'bg-content-muted' } as const
const { isCopied, copyToClipboard } = useClipboardCopy()
const copyAddress = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

watch(
  () => [chainId.value, props.address, family.value] as const,
  ([id, address, selectedFamily]) => {
    if (id) void loadVaultAssessment(id, address, selectedFamily)
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="flex flex-col gap-12 rounded-xl border border-line-subtle bg-surface p-16 text-p3"
    data-id="vault-checks-card"
    :data-address="address.toLowerCase()"
  >
    <div
      v-if="symbol"
      class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-8"
    >
      <div class="p2 min-w-0 break-words text-content-primary">
        {{ symbol }}
      </div>
      <div class="flex items-center gap-8 flex-shrink-0">
        <NuxtLink
          :to="getExplorerLink(address, chainId, true)"
          class="text-accent-600 underline cursor-pointer hover:text-accent-500"
          target="_blank"
        >
          {{ shortenAddress(address) }}
        </NuxtLink>
        <button
          type="button"
          class="text-content-muted"
          :aria-label="`Copy address ${address}`"
          @click="copyAddress(address)"
        >
          <SvgIcon
            class="!w-18 !h-18"
            :name="isCopied(address) ? 'check' : 'copy'"
          />
        </button>
      </div>
    </div>
    <div class="grid grid-cols-1 gap-12 sm:grid-cols-2">
      <div class="flex flex-col gap-4">
        <span class="text-content-tertiary">Status</span>
        <span
          :class="entry.status === 'unavailable' || statusLine === 'Not assessed yet' ? 'text-content-tertiary' : 'text-content-primary'"
          data-id="vault-checks-status"
        >{{ statusLine || 'Checking…' }}</span>
      </div>
      <UiModalPreviewTrigger
        v-if="hasFindings && cell"
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
            :class="toneClass[cell.tone]"
          />
          {{ cell.text }}
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
      v-if="lines.length"
      class="flex flex-col gap-8"
    >
      <li
        v-for="finding in lines"
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
          <NuxtLink
            v-if="finding.anchor"
            :to="{ hash: `#${finding.anchor}` }"
            class="ml-6 whitespace-nowrap text-accent-600 underline decoration-dotted hover:text-accent-500"
          >Show in Oracles</NuxtLink>
        </span>
      </li>
    </ul>
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
</template>
