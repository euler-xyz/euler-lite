<script setup lang="ts">
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getExplorerLink } from '~/utils/block-explorer'
import {
  enrichActivityAssetForDisplay,
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  formatActivityEventLabel,
  formatActivityTimestamp,
  formatActivityValuation,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityCategoryLabel,
  getActivityChangeEntries,
  getActivityEventIcon,
  getActivityParticipants,
} from '~/utils/activity-display'

const { event } = defineProps<{ event: ActivityEvent }>()

const expanded = ref(false)
const { getVault: getRegistryVault, registryVersion } = useVaultRegistry()
const { getTokenByAddress } = useTokenList()

const tokenMetadata = (address: `0x${string}`) => {
  const token = getTokenByAddress(address)
  if (!token) return undefined
  return {
    address: getAddress(token.address),
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
  }
}

const resolveAvatarAsset = (asset: ActivityEvent['assets'][number]) => {
  const representsVaultShares = asset.kind === 'shares'
    || (event.category === 'liquidations' && ['collateral', 'yield'].includes(asset.kind))
  const underlyingAsset = representsVaultShares && asset.address
    ? getRegistryVault(asset.address)?.asset
    : undefined
  if (underlyingAsset) {
    return { address: underlyingAsset.address, symbol: underlyingAsset.symbol }
  }
  return asset.address ? { address: asset.address, symbol: asset.symbol ?? '' } : null
}

const assets = computed(() => {
  // Re-resolve when vault or token metadata arrives after the activity page.
  void registryVersion.value
  return (event.assets ?? []).map((asset, index) => {
    const enriched = enrichActivityAssetForDisplay(
      asset,
      event,
      getRegistryVault,
      tokenMetadata,
    )
    const amount = formatActivityAssetAmount(enriched)
    return {
      kind: 'asset' as const,
      address: enriched.address,
      addressKind: getActivityAssetAddressLabel(enriched.kind, event.category),
      amount,
      avatarAsset: resolveAvatarAsset(enriched),
      key: `asset:${enriched.kind}:${enriched.address ?? 'unknown'}:${index}`,
      label: getActivityAssetLabel(enriched.kind, event.category),
      usd: formatActivityAssetUsd(enriched),
    }
  })
})
const changes = computed(() => getActivityChangeEntries(event.change).map(entry => ({
  kind: 'change' as const,
  key: `change:${entry.field}`,
  label: entry.label,
  value: entry.value,
  valueTitle: entry.value,
})))
const valuation = computed(() => formatActivityValuation(event.valuation))
const details = computed(() => [
  ...assets.value,
  ...changes.value,
  ...(valuation.value
    ? [{
        kind: 'valuation' as const,
        key: 'valuation',
        label: 'USD value',
        value: valuation.value,
        valueTitle: event.valuation?.reason,
      }]
    : []),
])
const participants = computed(() => getActivityParticipants(event).map(participant => ({
  ...participant,
  label: participant.label === 'User' && event.subAccountIndex !== undefined
    ? `User · Account ${event.subAccountIndex}`
    : participant.label,
})))
const hasExpandableMobileDetails = computed(() =>
  details.value.length > 1 || participants.value.length > 1,
)
const eventIcon = computed(() => getActivityEventIcon(event))
const eventLabel = computed(() => formatActivityEventLabel(event))
const transactionLink = computed(() => getExplorerLink(event.txHash, event.chainId))
</script>

<template>
  <li class="relative grid gap-10 border-b border-line-subtle py-12 last:border-b-0 laptop:grid-cols-[minmax(0,1.2fr)_minmax(220px,1fr)_minmax(190px,0.8fr)_44px] laptop:items-start laptop:gap-16">
    <div class="flex min-w-0 items-start gap-10 pr-48 laptop:pr-0">
      <div class="flex h-32 w-32 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary">
        <SvgIcon
          :name="eventIcon.name"
          class="!h-18 !w-18"
          aria-hidden="true"
        />
      </div>
      <div class="min-w-0">
        <div
          class="truncate text-p2 font-medium text-content-primary"
          :title="eventLabel"
        >
          {{ eventLabel }}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-x-8 gap-y-2 text-p4 text-content-tertiary">
          <span>{{ getActivityCategoryLabel(event.category) }}</span>
          <span aria-hidden="true">&middot;</span>
          <time :datetime="event.timestamp">{{ formatActivityTimestamp(event.timestamp) }}</time>
        </div>
      </div>
    </div>

    <div class="flex min-w-0 flex-col gap-6 pl-40 laptop:pl-0">
      <div
        v-for="(detail, index) in details"
        :key="detail.key"
        class="min-w-0"
        :class="index > 0 && !expanded ? 'hidden laptop:block' : ''"
      >
        <div class="text-p4 text-content-tertiary">
          {{ detail.label }}
        </div>

        <template v-if="detail.kind === 'asset'">
          <div class="mt-2 flex min-w-0 items-center gap-8">
            <AssetAvatar
              v-if="detail.avatarAsset"
              :asset="detail.avatarAsset"
              size="28"
            />
            <div class="min-w-0">
              <div
                class="break-words text-p3 text-content-primary"
              >
                {{ detail.amount }}
              </div>
              <div
                v-if="detail.usd"
                class="text-p4 text-content-tertiary"
              >
                {{ detail.usd }}
              </div>
            </div>
          </div>
          <div
            v-if="detail.address"
            class="mt-2 flex min-w-0 items-center gap-4 text-p4"
          >
            <span class="shrink-0 text-content-tertiary">{{ detail.addressKind }}</span>
            <ActivityAddress
              :address="detail.address"
              :chain-id="event.chainId"
            />
          </div>
        </template>

        <div
          v-else
          class="break-words text-p3 text-content-primary"
          :title="detail.valueTitle"
        >
          {{ detail.value }}
        </div>
      </div>

      <span
        v-if="details.length === 0"
        class="text-p4 text-content-muted"
      >No additional details</span>
    </div>

    <div class="flex min-w-0 flex-col gap-4 pl-40 text-p3 laptop:pl-0">
      <div
        v-for="(participant, index) in participants"
        :key="`${participant.label}:${participant.address}`"
        class="min-w-0 items-center gap-4"
        :class="[
          index > 0 && !expanded ? 'hidden laptop:flex' : 'flex',
        ]"
      >
        <span class="shrink-0 text-p4 text-content-tertiary">{{ participant.label }}</span>
        <ActivityAddress
          :address="participant.address"
          :chain-id="event.chainId"
        />
      </div>
      <span
        v-if="participants.length === 0"
        class="text-p4 text-content-muted"
      >No participants</span>
    </div>

    <button
      v-if="hasExpandableMobileDetails"
      type="button"
      class="ml-40 w-fit text-p4 font-medium text-content-secondary transition-colors hover:text-accent-500 laptop:hidden"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Hide details' : 'More details' }}
    </button>

    <div class="absolute right-0 top-8 laptop:static laptop:text-right">
      <a
        :href="transactionLink"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex h-40 w-40 items-center justify-center rounded-8 text-content-secondary transition-colors hover:bg-surface hover:text-accent-500"
        :aria-label="`View ${eventLabel} transaction`"
        title="View transaction"
      >
        <SvgIcon
          name="arrow-top-right"
          class="!h-18 !w-18"
          aria-hidden="true"
        />
      </a>
    </div>
  </li>
</template>
