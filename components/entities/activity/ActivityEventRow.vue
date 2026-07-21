<script setup lang="ts">
import type { ActivityCategory, ActivityEvent } from '@eulerxyz/euler-v2-sdk'
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
  getPortfolioActivityPositionParticipant,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'

const { event, showVault = false, viewerAddress, hideCategory = false, hiddenCategory, showTransactionLink = true, nowMs } = defineProps<{
  event: ActivityEvent
  showVault?: boolean
  /** Account whose feed is being viewed — hidden from participants to avoid repeating it on every row. */
  viewerAddress?: string
  /** Portfolio groups make the category redundant, while vault filters may still need it. */
  hideCategory?: boolean
  /** Category already implied by the active filter — omitted from the row to avoid restating it. */
  hiddenCategory?: ActivityCategory
  /** Composite portfolio operations link the transaction once at group level. */
  showTransactionLink?: boolean
  /** Feed-owned reactive clock shared by every visible event row. */
  nowMs: number
}>()

const route = useRoute()
const expanded = ref(false)
const {
  getVault: getRegistryVault,
  getType: getRegistryVaultType,
  getVaultCategory,
  getOrFetch: getOrFetchRegistryVault,
  registryVersion,
} = useVaultRegistry()
const { getTokenByAddress } = useTokenList()
const vaultAddress = computed(() => event.vault ?? '')
const vaultProduct = useEulerProductOfVault(vaultAddress)
const collateralVaultAddress = computed(() =>
  event.assets?.find(asset => asset.kind === 'collateral')?.address ?? '',
)
const collateralProduct = useEulerProductOfVault(collateralVaultAddress)

const metadataVaultAddresses = computed(() => showVault
  ? [...new Set([
      event.vault,
      ...(event.assets ?? [])
        .filter(asset => asset.kind === 'collateral' && asset.address)
        .map(asset => asset.address),
    ].filter((address): address is `0x${string}` => Boolean(address)))]
  : [])

watch(metadataVaultAddresses, (addresses) => {
  for (const address of addresses) void getOrFetchRegistryVault(address)
}, { immediate: true })

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
    const collateralVaultDisplay = event.category === 'liquidations'
      && enriched.kind === 'collateral'
      && enriched.address
      ? resolveActivityVaultDisplay(enriched.address, getRegistryVault, collateralProduct.name)
      : null
    return {
      kind: 'asset' as const,
      address: enriched.address,
      addressKind: getActivityAssetAddressLabel(enriched.kind, event.category),
      addressLabel: collateralVaultDisplay?.name,
      addressLinkKind: collateralVaultDisplay ? 'vault' as const : undefined,
      addressVaultType: enriched.address ? getRegistryVaultType(enriched.address) : undefined,
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
  return getActivityChangeEntries(event, activityVaultMetadata)
    .filter(entry => event.category !== 'liquidations' || entry.field !== 'collateral')
    .map(entry => ({
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

  if (showVault) {
    const position = getPortfolioActivityPositionParticipant(event)
    return position
      ? [{
          key: `position:${position.index}`,
          label: position.label,
          address: undefined,
          addressLabel: undefined,
          linkKind: undefined,
          vaultType: undefined,
          route: {
            path: `/position/${position.index}`,
            query: route.query,
          },
        }]
      : []
  }

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
          route: undefined,
          key: `${participant.label}:${participant.address}`,
        }
      }
      return {
        ...participant,
        label: participant.label === 'User' && event.subAccountIndex !== undefined
          ? `Position ${event.subAccountIndex}`
          : participant.label,
        addressLabel: undefined,
        vaultType: undefined,
        route: undefined,
        key: `${participant.label}:${participant.address}`,
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
  return {
    ...display,
    vault,
    route: {
      path: event.vaultType === 'earn' ? `/earn/${display.address}` : `/lend/${display.address}`,
      query: { network: route.query.network },
    },
  }
})
</script>

<template>
  <li class="activity-event-row relative -mx-12 grid items-center gap-10 rounded-8 border-b border-line-subtle px-12 py-12 transition-colors last:border-b-0 hover:bg-card-hover">
    <div class="activity-event-row__icon flex h-32 w-32 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary">
      <SvgIcon
        :name="eventIcon.name"
        class="!h-18 !w-18"
        aria-hidden="true"
      />
    </div>
    <div class="activity-event-row__title min-w-0 pr-48">
      <div
        class="line-clamp-2 break-words text-p2 font-medium text-content-primary"
        :title="eventLabel"
      >
        {{ eventLabel }}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-8 gap-y-2 text-p4 text-content-tertiary">
        <template v-if="!hideCategory && event.category !== hiddenCategory">
          <span>{{ getActivityCategoryLabel(event.category) }}</span>
          <span aria-hidden="true">&middot;</span>
        </template>
        <time
          class="whitespace-nowrap"
          :datetime="event.timestamp"
          :title="formatActivityTimestamp(event.timestamp)"
        >{{ formatActivityRelativeTimestamp(event.timestamp, nowMs) }}</time>
        <span
          v-for="participant in participants"
          :key="`inline:${participant.key}`"
          class="activity-event-row__participant-inline min-w-0 items-center gap-4"
        >
          <NuxtLink
            v-if="participant.route"
            :to="participant.route"
            class="font-medium text-content-secondary transition-colors hover:text-accent-500 hover:underline"
          >
            {{ participant.label }}
          </NuxtLink>
          <template v-else-if="participant.address">
            <span class="shrink-0">{{ participant.label }}</span>
            <ActivityAddress
              :address="participant.address"
              :chain-id="event.chainId"
              :label="participant.addressLabel"
              :link-kind="participant.linkKind"
              :vault-type="participant.vaultType"
            />
          </template>
        </span>
      </div>
      <div
        v-if="vaultDisplay"
        class="mt-8 min-w-0"
      >
        <NuxtLink
          :to="vaultDisplay.route"
          class="inline-flex max-w-full rounded-8 transition-opacity hover:opacity-80"
          :title="vaultDisplay.name || vaultDisplay.addressLabel"
        >
          <VaultLabelsAndAssets
            v-if="vaultDisplay.vault"
            :vault="vaultDisplay.vault"
            :assets="[vaultDisplay.vault.asset]"
          />
          <span
            v-else
            class="truncate text-p4 text-content-secondary hover:text-accent-500 hover:underline"
          >
            {{ vaultDisplay.name || vaultDisplay.addressLabel }}
          </span>
        </NuxtLink>
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
              size="20"
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
              :label="detail.addressLabel"
              :link-kind="detail.addressLinkKind"
              :vault-type="detail.addressVaultType"
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

    <div
      v-if="participants.length > 0"
      class="activity-event-row__participants flex min-w-0 flex-col gap-4 pl-40 text-p3"
    >
      <div
        v-for="(participant, index) in participants"
        :key="participant.key"
        class="min-w-0 items-center gap-4"
        :class="[
          index >= COLLAPSED_ENTRY_COUNT && !expanded ? 'activity-event-row__secondary-participant hidden' : 'flex',
        ]"
      >
        <NuxtLink
          v-if="participant.route"
          :to="participant.route"
          class="font-medium text-content-secondary transition-colors hover:text-accent-500 hover:underline"
        >
          {{ participant.label }}
        </NuxtLink>
        <template v-else-if="participant.address">
          <span class="shrink-0 text-p4 text-content-tertiary">{{ participant.label }}</span>
          <ActivityAddress
            :address="participant.address"
            :chain-id="event.chainId"
            :label="participant.addressLabel"
            :link-kind="participant.linkKind"
            :vault-type="participant.vaultType"
          />
        </template>
      </div>
    </div>

    <div
      v-if="showTransactionLink"
      class="activity-event-row__transaction absolute right-0 top-8"
    >
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
/* Stacked (narrow) layout: icon + title on the first line, details and
   participants as full-width lines underneath. */
.activity-event-row {
  grid-template-columns: 32px minmax(0, 1fr);
}

.activity-event-row__details,
.activity-event-row__participants {
  grid-column: 1 / -1;
}

/* Participants render inline in the meta line everywhere except the stacked
   mobile layout, which keeps the standalone block. */
.activity-event-row__participant-inline {
  display: none;
}

@container activity-feed (min-width: 520px) {
  .activity-event-row__participant-inline {
    display: inline-flex;
  }

  .activity-event-row__participants {
    display: none;
  }
}

@container activity-feed (min-width: 520px) {
  /* One rule for every row: the icon, details column, and transaction link
     center against the full card height, while the title line and the
     participants line stack top-down beside the icon. */
  .activity-event-row {
    grid-template-columns: 32px minmax(180px, 1fr) minmax(240px, 1.2fr) 40px;
    gap: 8px 16px;
  }

  .activity-event-row__icon,
  .activity-event-row__details,
  .activity-event-row__transaction {
    grid-row: 1 / -1;
  }

  .activity-event-row__title {
    grid-column: 2;
    grid-row: 1;
    padding-right: 0;
  }

  .activity-event-row__details {
    grid-column: 3;
    padding-left: 0;
  }

  .activity-event-row__transaction {
    position: static;
    grid-column: 4;
    justify-self: end;
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
      32px
      minmax(280px, 1fr)
      minmax(320px, 1.2fr)
      44px;
  }

  .activity-event-row__secondary-detail {
    display: block;
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
}
</style>
