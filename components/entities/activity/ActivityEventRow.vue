<script setup lang="ts">
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { getExplorerLink } from '~/utils/block-explorer'
import {
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  formatActivityEventLabel,
  formatActivityTimestamp,
  formatActivityValuation,
  enrichActivityAssetForDisplay,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityCategoryIcon,
  getActivityCategoryLabel,
  getActivityChangeEntries,
  getActivityParticipants,
} from '~/utils/activity-display'
import { shortenAddress } from '~/utils/string-utils'

const { event } = defineProps<{ event: ActivityEvent }>()

const { getVault: getRegistryVault, registryVersion } = useVaultRegistry()

const assets = computed(() => {
  // Re-resolve when vault metadata arrives after the activity page.
  void registryVersion.value
  return (event.assets ?? []).map((asset, index) => {
    const enriched = enrichActivityAssetForDisplay(asset, event, getRegistryVault)
    return {
      address: enriched.address,
      addressKind: getActivityAssetAddressLabel(enriched.kind, event.category),
      addressLabel: enriched.address ? shortenAddress(enriched.address) : null,
      addressLink: enriched.address ? getExplorerLink(enriched.address, event.chainId, true) : null,
      amount: formatActivityAssetAmount(enriched),
      key: `${enriched.kind}:${enriched.address ?? 'unknown'}:${index}`,
      label: getActivityAssetLabel(enriched.kind, event.category),
      usd: formatActivityAssetUsd(enriched),
    }
  })
})
const changes = computed(() => getActivityChangeEntries(event.change))
const participants = computed(() => getActivityParticipants(event).map(participant => ({
  ...participant,
  addressLabel: shortenAddress(participant.address),
  addressLink: getExplorerLink(participant.address, event.chainId, true),
  label: participant.label === 'User' && event.subAccountIndex !== undefined
    ? `User · Account ${event.subAccountIndex}`
    : participant.label,
})))
const hasAssetValuation = computed(() => assets.value.some(asset => asset.usd !== null))
const valuation = computed(() =>
  hasAssetValuation.value && event.valuation?.status === 'available'
    ? null
    : formatActivityValuation(event.valuation),
)
const hasDetails = computed(() => assets.value.length > 0 || changes.value.length > 0 || valuation.value !== null)
const transactionLink = computed(() => getExplorerLink(event.txHash, event.chainId))
</script>

<template>
  <li class="grid gap-16 border-b border-line-subtle py-16 last:border-b-0 laptop:grid-cols-[minmax(0,1.3fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_40px] laptop:items-start laptop:gap-12">
    <div class="flex min-w-0 items-start gap-12">
      <div class="flex h-36 w-36 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary">
        <SvgIcon
          :name="getActivityCategoryIcon(event.category)"
          class="!h-18 !w-18"
          aria-hidden="true"
        />
      </div>
      <div class="min-w-0">
        <div class="truncate text-p2 font-medium text-content-primary">
          {{ formatActivityEventLabel(event) }}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-x-8 gap-y-2 text-p4 text-content-tertiary">
          <span>{{ getActivityCategoryLabel(event.category) }}</span>
          <span aria-hidden="true">&middot;</span>
          <time :datetime="event.timestamp">{{ formatActivityTimestamp(event.timestamp) }}</time>
        </div>
      </div>
    </div>

    <div class="flex min-w-0 flex-col gap-8 pl-48 laptop:pl-0">
      <div class="text-p4 text-content-tertiary laptop:hidden">
        Details
      </div>

      <div
        v-for="asset in assets"
        :key="asset.key"
        class="min-w-0"
      >
        <div class="text-p4 text-content-tertiary">
          {{ asset.label }}
        </div>
        <div class="break-words text-p3 text-content-primary">
          {{ asset.amount }}
        </div>
        <div
          v-if="asset.usd"
          class="text-p4 text-content-tertiary"
        >
          {{ asset.usd }}
        </div>
        <div
          v-if="asset.addressLink"
          class="text-p4 text-content-tertiary"
        >
          {{ asset.addressKind }}
          <a
            :href="asset.addressLink"
            target="_blank"
            rel="noopener noreferrer"
            class="text-accent-600 underline transition-colors hover:text-accent-500"
          >{{ asset.addressLabel }}</a>
        </div>
      </div>

      <div
        v-for="entry in changes"
        :key="entry.field"
        class="min-w-0"
      >
        <div class="text-p4 text-content-tertiary">
          {{ entry.label }}
        </div>
        <div
          class="break-all text-p3 text-content-primary"
          :title="entry.value"
        >
          {{ entry.value }}
        </div>
      </div>

      <div
        v-if="valuation"
        class="text-p4 text-content-tertiary"
        :title="event.valuation?.reason"
      >
        {{ valuation }}
      </div>

      <span
        v-if="!hasDetails"
        class="text-content-tertiary"
      >Details unavailable</span>
    </div>

    <div class="flex min-w-0 flex-col gap-8 pl-48 text-p3 laptop:pl-0">
      <div class="text-p4 text-content-tertiary laptop:hidden">
        Participants
      </div>
      <div
        v-for="participant in participants"
        :key="participant.label"
        class="min-w-0"
      >
        <div class="text-p4 text-content-tertiary">
          {{ participant.label }}
        </div>
        <a
          :href="participant.addressLink"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent-600 underline transition-colors hover:text-accent-500"
        >
          {{ participant.addressLabel }}
        </a>
      </div>
      <span
        v-if="participants.length === 0"
        class="text-content-tertiary"
      >Participant unavailable</span>
    </div>

    <div class="pl-48 laptop:pl-0 laptop:text-right">
      <a
        :href="transactionLink"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex h-32 w-32 items-center justify-center rounded-8 text-content-secondary transition-colors hover:bg-surface hover:text-accent-500"
        :aria-label="`View ${formatActivityEventLabel(event)} transaction`"
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
