<script setup lang="ts">
import type { VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { getVaultCheckWarningLines } from '~/utils/vault-assessment/presentation'

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

const { isReady, source, vaultAssessments, getVaultAssessmentEntry, isVaultAssessmentAvailableForChain } = useEulerLabels()

const rows = computed(() => {
  void vaultAssessments.value
  if (!isReady.value || source.value !== 'v3') return []
  return props.vaults.flatMap((vault) => {
    if (!isVaultAssessmentAvailableForChain(vault.chainId)) return []
    const symbol = props.showSymbol ? vault.symbol : undefined
    const tone = vault.unverified ? 'error' : 'warning'
    const cause = vault.unverified && vault.cause ? [{ key: `${vault.address}:cause`, symbol, text: vault.cause, tone }] : []
    const entry = getVaultAssessmentEntry(vault.chainId, vault.address, vault.family ?? 'evk')
    if (entry.status !== 'available' || !entry.assessment?.assessed) return cause
    const checks = getVaultCheckWarningLines(entry.assessment)
      .map(line => ({ key: `${vault.address}:${line.key}`, symbol, text: line.text, tone: vault.unverified ? tone : line.outcome === 'unknown' ? 'muted' : tone }))
    return [...cause, ...checks]
  })
})
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
        >{{ row.symbol }} · </span>{{ row.text }}
      </span>
    </div>
  </div>
</template>
