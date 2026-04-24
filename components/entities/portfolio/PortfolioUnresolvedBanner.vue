<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { truncate } from '~/utils/string-utils'
import { getSubAccountIndex } from '~/entities/account'
import { getExplorerLink } from '~/utils/block-explorer'
import type { UnresolvedPosition, UnresolvedPositionVaultType } from '~/composables/useAccountPositions'

const {
  unresolvedPositions,
  portfolioAddress,
  refreshAllPositions,
  isPositionsLoading,
  isDepositsLoading,
} = useEulerAccount()
const { chainId, eulerLensAddresses } = useEulerAddresses()
const { address } = useAccount()
const { spyAddress, isSpyMode } = useSpyMode()

const dismissed = ref(false)

// Show whenever the unresolved list is non-empty; re-surfaces after dismissal
// if a subsequent refresh captures a fresh failure.
const positionCount = computed(() => unresolvedPositions.value.length)
const isVisible = computed(() => positionCount.value > 0 && !dismissed.value)

watch(positionCount, (count, prev) => {
  if (count > prev) dismissed.value = false
})

const isRetrying = computed(() => isPositionsLoading.value || isDepositsLoading.value)

const GROUP_ORDER: UnresolvedPositionVaultType[] = ['earn', 'evk', 'securitize', 'unknown']
const GROUP_LABELS: Record<UnresolvedPositionVaultType, string> = {
  earn: 'Earn vaults',
  evk: 'Lending vaults',
  securitize: 'Securitize vaults',
  unknown: 'Other vaults',
}

type Group = { type: UnresolvedPositionVaultType, label: string, items: UnresolvedPosition[] }

const groups = computed<Group[]>(() => {
  const bucket: Record<UnresolvedPositionVaultType, UnresolvedPosition[]> = {
    earn: [], evk: [], securitize: [], unknown: [],
  }
  for (const p of unresolvedPositions.value) bucket[p.vaultType].push(p)
  return GROUP_ORDER
    .filter(type => bucket[type].length > 0)
    .map(type => ({ type, label: GROUP_LABELS[type], items: bucket[type] }))
})

const ownerAddress = computed(() =>
  (isSpyMode.value ? spyAddress.value : address.value) || portfolioAddress.value || '',
)

const accountLabel = (subAccount: string): string => {
  const owner = ownerAddress.value
  if (!owner) return 'Account'
  try {
    const index = getSubAccountIndex(owner, subAccount)
    return index === 0 ? 'Main account' : `Account ${index}`
  }
  catch {
    return 'Account'
  }
}

const vaultExplorerLink = (vault: string) =>
  getExplorerLink(vault, chainId.value ?? undefined, true)

const headline = computed(() =>
  positionCount.value === 1
    ? 'We couldn\'t load 1 of your positions'
    : `We couldn't load ${positionCount.value} of your positions`,
)

const handleRetry = async () => {
  if (isRetrying.value) return
  const lens = eulerLensAddresses.value
  const owner = ownerAddress.value
  if (!lens || !owner) return
  await refreshAllPositions(lens, owner)
}
</script>

<template>
  <div
    v-if="isVisible"
    class="w-full rounded-12 border border-warning-300 bg-warning-100 p-16 text-warning-700 flex flex-col gap-12"
  >
    <div class="flex items-start gap-8">
      <SvgIcon
        name="warning"
        class="!w-20 !h-20 shrink-0 text-warning-500"
      />
      <div class="flex-1 flex flex-col gap-4">
        <p class="text-p2 font-semibold text-warning-700">
          {{ headline }}
        </p>
        <p class="text-p4 text-warning-700/80">
          This is usually a temporary issue. Your funds are safe on-chain. If the problem persists,
          please reach out to the team.
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 p-4 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
        @click="dismissed = true"
      >
        <SvgIcon
          name="close"
          class="!w-16 !h-16"
        />
      </button>
    </div>

    <div class="flex flex-col gap-8 pl-28">
      <div
        v-for="group in groups"
        :key="group.type"
        class="flex flex-col gap-4"
      >
        <p class="text-p4 font-semibold text-warning-700">
          {{ group.label }}
          <span class="opacity-60">({{ group.items.length }})</span>
        </p>
        <ul class="flex flex-col gap-4">
          <li
            v-for="item in group.items"
            :key="`${item.kind}:${item.subAccount}:${item.vault}`"
            class="flex items-center gap-8 text-p4"
          >
            <span class="inline-flex items-center rounded-4 bg-warning-500/15 text-warning-700 px-6 py-1 text-p5 uppercase tracking-wide">
              {{ item.kind }}
            </span>
            <span class="text-warning-700/80">{{ accountLabel(item.subAccount) }}</span>
            <span class="text-warning-700/60">·</span>
            <NuxtLink
              :to="vaultExplorerLink(item.vault)"
              target="_blank"
              rel="noopener"
              class="font-mono underline decoration-dotted underline-offset-2 text-warning-700 hover:text-warning-500"
              :title="item.vault"
            >
              {{ truncate(item.vault) }}
            </NuxtLink>
          </li>
        </ul>
      </div>
    </div>

    <div class="flex justify-end">
      <button
        type="button"
        class="inline-flex items-center gap-6 rounded-8 border border-warning-500/40 bg-warning-500/10 px-12 py-6 text-p4 font-semibold text-warning-700 hover:bg-warning-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        :disabled="isRetrying"
        @click="handleRetry"
      >
        <SvgIcon
          name="refresh"
          :class="['!w-14 !h-14', { 'animate-spin': isRetrying }]"
        />
        {{ isRetrying ? 'Retrying…' : 'Retry' }}
      </button>
    </div>
  </div>
</template>
