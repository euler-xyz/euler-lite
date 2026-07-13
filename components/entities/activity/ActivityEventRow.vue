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
  getActivityAssetsForDisplay,
  getActivityCategoryLabel,
  getActivityChangeEntries,
  getActivityEventIcon,
  getActivityParticipants,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'

const { event, showVault = false } = defineProps<{
  event: ActivityEvent
  showVault?: boolean
}>()

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
  return getActivityAssetsForDisplay(event).map((asset, index) => {
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
const vaultDisplay = computed(() => {
  if (!showVault) return null
  // Re-resolve when vault metadata arrives after the activity page.
  void registryVersion.value
  const display = resolveActivityVaultDisplay(event.vault, getRegistryVault)
  if (!display) return null
  return {
    ...display,
    link: getExplorerLink(display.address, event.chainId, true),
  }
})
</script>

<template>
  <li class="activity-event-row relative grid gap-10 border-b border-line-subtle py-12 transition-colors last:border-b-0 hover:bg-card-hover">
    <div class="activity-event-row__summary">
      <div class="activity-event-row__event flex min-w-0 items-start gap-10 pr-48">
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
            <time
              class="whitespace-nowrap"
              :datetime="event.timestamp"
            >{{ formatActivityTimestamp(event.timestamp) }}</time>
          </div>
          <div
            v-if="vaultDisplay"
            class="mt-2 flex min-w-0 items-center gap-4 text-p4 text-content-tertiary"
          >
            <span class="shrink-0">Market</span>
            <a
              :href="vaultDisplay.link"
              target="_blank"
              rel="noopener noreferrer"
              class="flex min-w-0 items-center gap-4 text-accent-600 underline transition-colors hover:text-accent-500"
              :title="vaultDisplay.address"
            >
              <span
                v-if="vaultDisplay.name"
                class="truncate"
              >{{ vaultDisplay.name }}</span>
              <span
                v-if="vaultDisplay.name"
                class="shrink-0"
                aria-hidden="true"
              >&middot;</span>
              <span class="shrink-0">{{ vaultDisplay.addressLabel }}</span>
            </a>
          </div>
        </div>
      </div>

      <div class="activity-event-row__meta">
        <div class="activity-event-row__participants flex min-w-0 flex-col gap-4 pl-40 text-p3">
          <div
            v-for="(participant, index) in participants"
            :key="`${participant.label}:${participant.address}`"
            class="min-w-0 items-center gap-4"
            :class="[
              index > 0 && !expanded ? 'activity-event-row__secondary-participant hidden' : 'flex',
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
          class="activity-event-row__more ml-40 inline-flex h-28 w-fit shrink-0 items-center gap-4 rounded-8 border border-line-subtle bg-surface px-8 text-p4 font-medium text-content-secondary transition-colors hover:border-line hover:text-content-primary"
          :aria-expanded="expanded"
          :aria-label="`${expanded ? 'Hide' : 'Show'} additional ${eventLabel} details`"
          @click="expanded = !expanded"
        >
          <span>{{ expanded ? 'Less' : 'Details' }}</span>
          <SvgIcon
            name="arrow-down"
            class="!h-14 !w-14 transition-transform"
            :class="{ 'rotate-180': expanded }"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>

    <div class="activity-event-row__details flex min-w-0 flex-col gap-6 pl-40">
      <div
        v-for="(detail, index) in details"
        :key="detail.key"
        class="min-w-0"
        :class="index > 0 && !expanded ? 'activity-event-row__secondary-detail hidden' : ''"
      >
        <div
          class="text-p4 text-content-tertiary"
          :class="{ 'activity-event-row__asset-label': detail.kind === 'asset' }"
        >
          {{ detail.label }}
        </div>

        <template v-if="detail.kind === 'asset'">
          <div class="activity-event-row__asset-amount mt-2 flex min-w-0 items-center gap-8">
            <AssetAvatar
              v-if="detail.avatarAsset"
              :asset="detail.avatarAsset"
              size="28"
            />
            <div class="min-w-0">
              <div
                class="break-words text-p3 font-medium text-content-primary"
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
            class="activity-event-row__asset-address mt-2 flex min-w-0 items-center gap-4 text-p4"
          >
            <span class="activity-event-row__asset-address-kind shrink-0 text-content-tertiary">{{ detail.addressKind }}</span>
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

    <div class="activity-event-row__transaction absolute right-0 top-8">
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

<style scoped>
.activity-event-row__summary,
.activity-event-row__meta {
  display: contents;
}

.activity-event-row__event {
  order: 1;
}

.activity-event-row__details {
  order: 2;
}

.activity-event-row__participants {
  order: 3;
}

.activity-event-row__more {
  order: 4;
}

@container activity-feed (min-width: 520px) {
  .activity-event-row {
    grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr);
    align-items: start;
    gap: 16px;
  }

  .activity-event-row__summary {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
  }

  .activity-event-row__event,
  .activity-event-row__meta {
    order: initial;
  }

  .activity-event-row__meta {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 12px;
    padding-left: 40px;
  }

  .activity-event-row__details {
    order: initial;
    padding-left: 0;
  }

  .activity-event-row__participants {
    min-width: 0;
    flex: 1 1 auto;
    padding-left: 0;
  }

  .activity-event-row__more {
    margin-left: 0;
  }

  .activity-event-row__asset-label,
  .activity-event-row__asset-address-kind {
    display: none;
  }

  .activity-event-row__asset-amount {
    margin-top: 0;
  }

  .activity-event-row__asset-address {
    margin-top: 4px;
  }
}

@container activity-feed (min-width: 900px) {
  .activity-event-row {
    grid-template-columns:
      minmax(280px, 1.1fr)
      minmax(260px, 1.2fr)
      minmax(220px, 1fr)
      44px;
  }

  .activity-event-row__summary,
  .activity-event-row__meta {
    display: contents;
  }

  .activity-event-row__event,
  .activity-event-row__details,
  .activity-event-row__participants,
  .activity-event-row__transaction {
    grid-row: 1;
  }

  .activity-event-row__event {
    grid-column: 1;
  }

  .activity-event-row__details {
    grid-column: 2;
  }

  .activity-event-row__participants {
    grid-column: 3;
  }

  .activity-event-row__transaction {
    grid-column: 4;
  }

  .activity-event-row__event,
  .activity-event-row__participants {
    padding-left: 0;
    padding-right: 0;
  }

  .activity-event-row__secondary-detail {
    display: block;
  }

  .activity-event-row__secondary-participant {
    display: flex;
  }

  .activity-event-row__more {
    display: none;
  }

  .activity-event-row__asset-label {
    display: block;
  }

  .activity-event-row__asset-address-kind {
    display: inline;
  }

  .activity-event-row__asset-amount,
  .activity-event-row__asset-address {
    margin-top: 2px;
  }

  .activity-event-row__transaction {
    position: static;
    text-align: right;
  }
}
</style>
