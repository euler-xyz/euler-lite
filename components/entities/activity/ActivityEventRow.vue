<script setup lang="ts">
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getExplorerLink } from '~/utils/block-explorer'
import {
  enrichActivityAssetForDisplay,
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  formatActivityEventLabel,
  formatActivityRelativeTimestamp,
  formatActivityTimestamp,
  formatActivityValuationForAssets,
  getActivityAmountDirection,
  getActivityAssetAddressLabel,
  getActivityAssetLabel,
  getActivityAssetsForDisplay,
  getActivityCategoryLabel,
  getActivityChangeEntries,
  getActivityEventIcon,
  getActivityParticipants,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'

const { event, showVault = false, viewerAddress } = defineProps<{
  event: ActivityEvent
  showVault?: boolean
  /** Account whose feed is being viewed — hidden from participants to avoid repeating it on every row. */
  viewerAddress?: string
}>()

const route = useRoute()
const expanded = ref(false)
const {
  getVault: getRegistryVault,
  getType: getRegistryVaultType,
  getVaultCategory,
  registryVersion,
} = useVaultRegistry()
const { getTokenByAddress } = useTokenList()
const vaultAddress = computed(() => event.vault ?? '')
const vaultProduct = useEulerProductOfVault(vaultAddress)

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

const activityVaultMetadata = (address: `0x${string}`) => {
  const vault = getRegistryVault(address)
  if (!vault) return undefined
  return {
    asset: vault.asset,
    shares: vault.shares,
    vaultType: getRegistryVaultType(address),
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
  const direction = event.type === 'approval' ? undefined : getActivityAmountDirection(event)
  return getActivityAssetsForDisplay(event).map((asset, index) => {
    const enriched = enrichActivityAssetForDisplay(
      asset,
      event,
      getRegistryVault,
      tokenMetadata,
    )
    const amount = formatActivityAssetAmount(enriched, event.type)
    const signed = amount !== 'Amount unavailable' && direction
    const label = getActivityAssetLabel(enriched.kind, event.category, event.type)
    return {
      kind: 'asset' as const,
      address: enriched.address,
      addressKind: getActivityAssetAddressLabel(enriched.kind, event.category),
      amount: signed ? `${direction === 'in' ? '+' : '−'}${amount}` : amount,
      amountClass: signed && direction === 'in' ? 'text-accent-600' : 'text-content-primary',
      amountTitle: amount === 'Amount unavailable' ? `Raw units: ${enriched.amountRaw}` : undefined,
      avatarAsset: resolveAvatarAsset(enriched),
      key: `asset:${enriched.kind}:${enriched.address ?? 'unknown'}:${index}`,
      // The generic "Assets" label restates what the amount already shows —
      // keep only informative labels (Allowance, Debt repaid, …).
      label: label === 'Assets' ? undefined : label,
      usd: formatActivityAssetUsd(enriched),
    }
  })
})
const changes = computed(() => {
  // Re-resolve human-readable vault names when registry metadata arrives.
  void registryVersion.value
  return getActivityChangeEntries(event, activityVaultMetadata).map(entry => ({
    kind: 'change' as const,
    key: `change:${entry.field}`,
    label: entry.label,
    value: entry.value,
    valueTitle: entry.value,
    addresses: entry.addresses,
  }))
})
const valuation = computed(() => formatActivityValuationForAssets(event.valuation, event.assets ?? []))
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
        addresses: undefined,
      }]
    : []),
])
const participants = computed(() => {
  // Re-resolve participant vault names when registry metadata arrives.
  void registryVersion.value
  const viewer = viewerAddress?.toLowerCase()
  return getActivityParticipants(event)
    .filter(participant => participant.address.toLowerCase() !== viewer)
    .map((participant) => {
      // Known vaults (e.g. Earn vaults acting on underlying markets) read
      // better as named vault links than as spy-mode "User 0x…" addresses.
      const vaultDisplay = getRegistryVault(participant.address)
        ? resolveActivityVaultDisplay(participant.address, getRegistryVault)
        : null
      if (vaultDisplay) {
        return {
          ...participant,
          label: participant.label === 'User' ? 'Vault' : participant.label,
          linkKind: 'vault' as const,
          addressLabel: vaultDisplay.name,
          vaultType: getRegistryVaultType(participant.address),
        }
      }
      return {
        ...participant,
        label: participant.label === 'User' && event.subAccountIndex !== undefined
          ? `Position ${event.subAccountIndex}`
          : participant.label,
        addressLabel: undefined,
        vaultType: undefined,
      }
    })
})
// Collapsing behind a toggle only pays off when it hides more than one row —
// with exactly two entries, showing both is shorter than the button.
const COLLAPSED_ENTRY_COUNT = 2
const hiddenEntryCount = computed(() =>
  Math.max(0, details.value.length - COLLAPSED_ENTRY_COUNT)
  + Math.max(0, participants.value.length - COLLAPSED_ENTRY_COUNT),
)
const hasExpandableMobileDetails = computed(() => hiddenEntryCount.value > 0)
const eventIcon = computed(() => getActivityEventIcon(event))
const eventLabel = computed(() => formatActivityEventLabel(event))
const transactionLink = computed(() => getExplorerLink(event.txHash, event.chainId))
const vaultDisplay = computed(() => {
  if (!showVault) return null
  // Re-resolve when vault metadata arrives after the activity page.
  void registryVersion.value
  const productName = event.vault && getVaultCategory(event.vault) === 'escrow'
    ? 'Escrowed collateral'
    : vaultProduct.name
  const display = resolveActivityVaultDisplay(event.vault, getRegistryVault, productName)
  if (!display) return null
  const vault = getRegistryVault(display.address)
  const asset = vault?.asset
  return {
    ...display,
    avatarAsset: asset ? { address: asset.address, symbol: asset.symbol } : null,
    route: {
      path: event.vaultType === 'earn' ? `/earn/${display.address}` : `/lend/${display.address}`,
      query: { network: route.query.network },
    },
  }
})
</script>

<template>
  <li
    class="activity-event-row relative grid gap-10 border-b border-line-subtle py-12 transition-colors last:border-b-0 hover:bg-card-hover"
    :class="{ 'activity-event-row--static': !hasExpandableMobileDetails }"
  >
    <div class="activity-event-row__summary">
      <div class="activity-event-row__event flex min-w-0 items-center gap-10 pr-48">
        <div class="flex h-32 w-32 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary">
          <SvgIcon
            :name="eventIcon.name"
            class="!h-18 !w-18"
            aria-hidden="true"
          />
        </div>
        <div class="min-w-0">
          <div
            class="line-clamp-2 break-words text-p2 font-medium text-content-primary"
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
              :title="formatActivityTimestamp(event.timestamp)"
            >{{ formatActivityRelativeTimestamp(event.timestamp) }}</time>
          </div>
          <div
            v-if="vaultDisplay"
            class="mt-4 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-p4"
          >
            <span class="text-content-tertiary">Market</span>
            <AssetAvatar
              v-if="vaultDisplay.avatarAsset"
              :asset="vaultDisplay.avatarAsset"
              size="20"
            />
            <NuxtLink
              v-if="vaultDisplay.name"
              :to="vaultDisplay.route"
              class="min-w-0 truncate text-content-secondary transition-colors hover:text-accent-500 hover:underline"
              :title="vaultDisplay.name"
            >
              {{ vaultDisplay.name }}
            </NuxtLink>
            <ActivityAddress
              :address="vaultDisplay.address"
              :chain-id="event.chainId"
              :label="vaultDisplay.addressLabel"
              link-kind="vault"
              :vault-type="event.vaultType"
            />
          </div>
        </div>
      </div>

      <div
        v-if="participants.length > 0"
        class="activity-event-row__meta"
      >
        <div class="activity-event-row__participants flex min-w-0 flex-col gap-4 pl-40 text-p3">
          <div
            v-for="(participant, index) in participants"
            :key="`${participant.label}:${participant.address}`"
            class="min-w-0 items-center gap-4"
            :class="[
              index >= COLLAPSED_ENTRY_COUNT && !expanded ? 'activity-event-row__secondary-participant hidden' : 'flex',
            ]"
          >
            <span class="shrink-0 text-p4 text-content-tertiary">{{ participant.label }}</span>
            <ActivityAddress
              :address="participant.address"
              :chain-id="event.chainId"
              :label="participant.addressLabel"
              :link-kind="participant.linkKind"
              :vault-type="participant.vaultType"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="activity-event-row__details flex min-w-0 flex-col gap-6 pl-40">
      <div
        v-for="(detail, index) in details"
        :key="detail.key"
        class="min-w-0"
        :class="index >= COLLAPSED_ENTRY_COUNT && !expanded ? 'activity-event-row__secondary-detail hidden' : ''"
      >
        <div
          v-if="detail.label"
          class="text-p4 text-content-tertiary"
          :class="{ 'activity-event-row__asset-label': detail.kind === 'asset' }"
        >
          {{ detail.label }}
        </div>

        <template v-if="detail.kind === 'asset'">
          <div
            class="activity-event-row__asset-amount mt-2 flex min-w-0 items-center gap-8"
            :title="detail.address"
          >
            <AssetAvatar
              v-if="detail.avatarAsset"
              :asset="detail.avatarAsset"
              size="28"
            />
            <div class="min-w-0">
              <div
                class="break-words text-p3 font-medium"
                :class="detail.amountClass"
                :title="detail.amountTitle"
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
            v-if="detail.address && detail.addressKind !== 'Asset'"
            class="activity-event-row__asset-address mt-2 flex min-w-0 items-center gap-4 text-p4"
          >
            <span class="activity-event-row__asset-address-kind shrink-0 text-content-tertiary">{{ detail.addressKind }}</span>
            <ActivityAddress
              :address="detail.address"
              :chain-id="event.chainId"
            />
          </div>
        </template>

        <template v-else>
          <div
            v-if="detail.addresses?.length"
            class="mt-2 flex min-w-0 flex-col items-start gap-2 text-p3"
          >
            <ActivityAddress
              v-for="address in detail.addresses"
              :key="address.address"
              :address="address.address"
              :chain-id="event.chainId"
              :label="address.label"
              :link-kind="address.linkKind"
              :vault-type="address.vaultType"
            />
          </div>
          <div
            v-else
            class="break-words text-p3 text-content-primary"
            :title="detail.valueTitle"
          >
            {{ detail.value }}
          </div>
        </template>
      </div>

      <button
        v-if="hasExpandableMobileDetails"
        type="button"
        class="activity-event-row__more inline-flex w-fit items-center gap-4 text-p4 text-content-tertiary transition-colors hover:text-content-primary"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? 'Hide' : 'Show'} additional ${eventLabel} details`"
        @click="expanded = !expanded"
      >
        <span>{{ expanded ? 'Show less' : `+${hiddenEntryCount} more` }}</span>
        <SvgIcon
          name="arrow-down"
          class="!h-12 !w-12 transition-transform"
          :class="{ 'rotate-180': expanded }"
          aria-hidden="true"
        />
      </button>
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

@container activity-feed (min-width: 520px) {
  .activity-event-row {
    grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.2fr);
    align-items: start;
    gap: 16px;
  }

  /* Without an expand toggle the summary reads better centered against the
     (usually taller) details column. Expandable rows stay top-anchored so
     nothing jumps when they grow. */
  .activity-event-row--static {
    align-items: center;
  }

  .activity-event-row--static .activity-event-row__transaction {
    top: 50%;
    transform: translateY(-50%);
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
  /* The expand toggle never renders at table width, so middle-align every
     row's cells like a conventional table. */
  .activity-event-row {
    grid-template-columns:
      minmax(280px, 1.1fr)
      minmax(260px, 1.2fr)
      minmax(220px, 1fr)
      44px;
    align-items: center;
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
    transform: none;
  }
}
</style>
