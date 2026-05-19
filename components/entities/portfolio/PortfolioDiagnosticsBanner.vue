<script setup lang="ts">
import type { DataIssue } from '@eulerxyz/euler-v2-sdk'

const { portfolioDiagnostics } = useEulerAccount()

const dismissed = ref(false)

const metadataOnlyPaths = new Set([
  '$.timestamp',
  '$.lastAccountStatusCheckTimestamp',
  '$.governance.pendingTimelockValidAt',
  '$.governance.pendingGuardianValidAt',
  '$.allocationCap.pendingValidAt',
  '$.removableAt',
])

// Sources whose warnings come from the onchain (vaultLens/accountLens) path.
// When a FALLBACK_USED issue is present from the matching V3 primary, these
// are downstream noise from the secondary that has already populated the data.
const FALLBACK_SECONDARY_SOURCES_BY_PRIMARY: Record<string, readonly string[]> = {
  accountV3: ['accountLens', 'vaultLens'],
  eVaultV3: ['vaultLens'],
  eulerEarnV3: ['vaultLens', 'eulerEarnVault'],
}

const isPortfolioImpactingDiagnostic = (issue: DataIssue, fallbackPrimaries: Set<string>): boolean => {
  const locations = issue.locations ?? []
  const paths = locations.map(location => location.path)

  if (paths.length > 0 && paths.every(path => metadataOnlyPaths.has(path))) {
    return false
  }

  if (
    issue.severity === 'warning'
    && paths.length > 0
    && paths.every(path => path.endsWith('oraclePriceRaw'))
  ) {
    return false
  }

  if (issue.severity === 'warning' && issue.source) {
    for (const primary of fallbackPrimaries) {
      if (FALLBACK_SECONDARY_SOURCES_BY_PRIMARY[primary]?.includes(issue.source)) {
        return false
      }
    }
  }

  return issue.severity === 'error' || issue.severity === 'warning'
}

const relevantDiagnostics = computed(() => {
  const fallbackPrimaries = new Set(
    portfolioDiagnostics.value
      .filter(issue => issue.code === 'FALLBACK_USED' && issue.source)
      .map(issue => issue.source as string),
  )
  return portfolioDiagnostics.value.filter(issue =>
    isPortfolioImpactingDiagnostic(issue, fallbackPrimaries),
  )
})
const totalCount = computed(() => relevantDiagnostics.value.length)

watch(totalCount, (count, prev) => {
  if (count > prev) dismissed.value = false
})

const isVisible = computed(() => totalCount.value > 0 && !dismissed.value)
const sourceSummary = computed(() => {
  const sources = [...new Set(relevantDiagnostics.value.map(issue => issue.source).filter(Boolean))]
  if (!sources.length) return ''
  return sources.slice(0, 3).join(', ')
})

const message = computed(() => {
  const count = totalCount.value
  const suffix = sourceSummary.value ? ` (${sourceSummary.value})` : ''
  return count === 1
    ? `Some portfolio data could not be fully loaded${suffix}.`
    : `Some portfolio data could not be fully loaded: ${count} diagnostics${suffix}.`
})
</script>

<template>
  <Transition name="hint">
    <div
      v-if="isVisible"
      class="flex items-center gap-8 bg-warning-100 rounded-12 p-12 mx-16"
    >
      <SvgIcon
        name="info-circle"
        class="!w-20 !h-20 text-warning-500 shrink-0"
      />
      <span class="text-warning-500 text-p4 flex-1">
        {{ message }}
        Values or position details may be incomplete.
      </span>
      <button
        type="button"
        class="shrink-0 w-20 h-20 flex items-center justify-center self-start text-warning-500 hover:text-warning-500/70 transition-colors"
        @click="dismissed = true"
      >
        &#x2715;
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.hint-enter-active,
.hint-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.hint-enter-from,
.hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
