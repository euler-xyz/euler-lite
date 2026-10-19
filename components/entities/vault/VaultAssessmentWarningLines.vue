<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { getVaultCheckWarningLines, getWarningAdapterFailures, type VaultCheckLine } from '~/utils/vault-assessment/presentation'

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
const adapterLabel = (address: string) => {
  const meta = oracleAdapters[address.toLowerCase()]
  return meta?.label || meta?.name || undefined
}
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
}

const rows = computed((): WarningRow[] => {
  void vaultAssessments.value
  if (!isReady.value || source.value !== 'v3') return []
  return props.vaults.flatMap((vault) => {
    if (!isVaultAssessmentAvailableForChain(vault.chainId)) return []
    const symbol = props.showSymbol ? vault.symbol : undefined
    const tone = vault.unverified ? 'error' : 'warning'
    const cause: WarningRow[] = vault.unverified && vault.cause ? [{ key: `${vault.address}:cause`, checkKey: '', symbol, text: vault.cause, tone, parts: undefined }] : []
    const entry = getVaultAssessmentEntry(vault.chainId, vault.address, vault.family ?? 'evk')
    if (entry.status !== 'available' || !entry.assessment?.assessed) return cause
    const checks = getVaultCheckWarningLines(entry.assessment, { adapterLabel })
      .map((line): WarningRow => ({ key: `${vault.address}:${line.key}`, checkKey: line.key, symbol, text: line.text, parts: line.parts, tone: vault.unverified ? tone : line.outcome === 'unknown' ? 'muted' : tone }))
    return [...cause, ...checks]
  })
})
const { ensureResolved } = useVaultReferences()
watch(rows, list => ensureResolved(list.map(row => ({ key: row.checkKey, parts: row.parts }))), { immediate: true })
</script>

<template>
  <div
    v-if="rows.length"
    class="flex flex-col gap-6 border-t border-line-subtle px-16 py-10 text-p3"
    data-id="vault-assessment-warning-lines"
  >
    <div
      v-for="row in rows"
      :key="row.key"
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
  </div>
</template>
