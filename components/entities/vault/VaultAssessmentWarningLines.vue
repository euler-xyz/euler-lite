<script setup lang="ts">
import type { VaultAssessmentFamily, VaultAssessment } from '@eulerxyz/euler-v2-sdk'
import { getVaultCheckWarningLines, getWarningAdapterFailures, orderVaultCheckLinesForSummary, type VaultCheckLine } from '~/utils/vault-assessment/presentation'
import { UiModalPreviewTrigger, VaultAssessmentChecksModal } from '#components'
import { isRestatedByCheckLine } from '~/utils/vault-assessment/flagged'
import { formatUnboundedStaleness } from '~/entities/oracle'

export type VaultAssessmentWarningTarget = {
  address: string
  chainId: number
  family?: VaultAssessmentFamily
  symbol?: string
  /** Unknown to the app: the cause comes first and every failing check is an error. */
  unverified?: boolean
  cause?: string | null
}

const props = withDefaults(defineProps<{
  vaults: VaultAssessmentWarningTarget[]
  showSymbol?: boolean
}>(), { showSymbol: false })

const { isReady, source, vaultAssessments, getVaultAssessmentEntry, isVaultAssessmentAvailableForChain, oracleAdapters, loadOracleAdapters } = useEulerLabels()
const { ensureResolved, adapterLabel } = useVaultReferences()
const adapterAddresses = computed(() => {
  void vaultAssessments.value
  return props.vaults.flatMap((vault) => {
    const entry = getVaultAssessmentEntry(vault.chainId, vault.address, vault.family ?? 'evk')
    const findings = [...(entry.assessment?.configContext?.findings ?? []), ...(entry.assessment?.consistencyContext?.findings ?? [])]
    return findings.flatMap(finding => getWarningAdapterFailures(finding).map(failure => ({ chainId: vault.chainId, address: failure.address })))
  })
})
watch(adapterAddresses, (targets) => {
  const byChain = new Map<number, string[]>()
  for (const target of targets) {
    if (oracleAdapters[target.address.toLowerCase()]) continue
    byChain.set(target.chainId, [...(byChain.get(target.chainId) ?? []), target.address])
  }
  for (const [chainId, addresses] of byChain) void loadOracleAdapters(chainId, addresses)
}, { immediate: true })

type WarningRow = {
  key: string
  checkKey: string
  symbol?: string
  text: string
  parts: VaultCheckLine['parts']
  tone: 'error' | 'warning' | 'muted'
  more?: { count: number, assessment: VaultAssessment }
}

const SUMMARY_LINES = 3

const rows = computed((): WarningRow[] => {
  void vaultAssessments.value
  if (!isReady.value || source.value !== 'v3') return []
  return props.vaults.flatMap((vault) => {
    if (!isVaultAssessmentAvailableForChain(vault.chainId)) return []
    const symbol = props.showSymbol ? vault.symbol : undefined
    const tone = vault.unverified ? 'error' : 'warning'
    const causeText = vault.cause ? formatUnboundedStaleness(vault.cause) : ''
    const cause: WarningRow[] = vault.unverified && causeText ? [{ key: `${vault.address}:cause`, checkKey: '', symbol, text: causeText, tone, parts: undefined }] : []
    const entry = getVaultAssessmentEntry(vault.chainId, vault.address, vault.family ?? 'evk')
    if (entry.status !== 'available' || !entry.assessment?.assessed) return cause
    const checks = orderVaultCheckLinesForSummary(getVaultCheckWarningLines(entry.assessment, { adapterLabel }))
      .map((line): WarningRow => ({ key: `${vault.address}:${line.key}`, checkKey: line.key, symbol, text: line.text, parts: line.parts, tone: vault.unverified ? tone : line.outcome === 'unknown' ? 'muted' : tone }))
    const shownBesideCause = checks.slice(0, SUMMARY_LINES - cause.length)
    const restated = !!causeText && isRestatedByCheckLine(causeText, shownBesideCause.map(check => check.text))
    const shown = restated ? checks.slice(0, SUMMARY_LINES) : shownBesideCause
    const hidden = checks.length - shown.length
    const more: WarningRow[] = hidden > 0
      ? [{ key: `${vault.address}:more`, checkKey: '', symbol, text: `+${hidden} more · see checks`, parts: undefined, tone: 'muted', more: { count: hidden, assessment: entry.assessment } }]
      : []
    return [...(restated ? [] : cause), ...shown, ...more]
  })
})
watch(rows, list => ensureResolved(list.filter(row => !row.more).map(row => ({ key: row.checkKey, parts: row.parts }))), { immediate: true })
</script>

<template>
  <div
    v-if="rows.length"
    class="flex flex-col gap-6 border-t border-line-subtle px-16 py-10 text-p3"
    data-id="vault-assessment-warning-lines"
  >
    <template
      v-for="row in rows"
      :key="row.key"
    >
      <div
        v-if="row.more"
        class="flex items-start gap-8 pl-24 text-content-tertiary"
        :data-tone="row.tone"
        data-id="vault-assessment-warning-more"
      >
        <UiModalPreviewTrigger
          :component="VaultAssessmentChecksModal"
          :modal-data="{ props: { assessment: row.more.assessment } }"
          :aria-label="row.symbol ? `${row.symbol} · ${row.text}` : row.text"
          placement="top-start"
          popover-width="wide"
          class="cursor-pointer underline decoration-dotted hover:text-content-secondary"
        >
          <span v-if="row.symbol">{{ row.symbol }} · </span>{{ row.text }}
        </UiModalPreviewTrigger>
      </div>
      <div
        v-else
        class="flex items-start gap-8"
        :class="row.tone === 'error' ? 'text-error-500' : row.tone === 'warning' ? 'text-warning-500' : 'text-content-tertiary'"
        :data-tone="row.tone"
      >
        <SvgIcon
          v-if="row.tone !== 'muted'"
          name="warning"
          class="mt-1 !w-16 !h-16 shrink-0"
        />
        <span class="min-w-0 break-words text-content-secondary">
          <span
            v-if="row.symbol"
            class="text-content-primary"
          >{{ row.symbol }} · </span><template v-if="row.parts">
            <template
              v-for="(part, index) in row.parts"
              :key="index"
            >
              <VaultReference
                v-if="part.address"
                :address="part.address"
                :fallback="part.text"
                :linkable="false"
              />
              <template v-else>{{ part.text }}</template>
            </template>
          </template><template v-else>{{ row.text }}</template>
        </span>
      </div>
    </template>
  </div>
</template>
