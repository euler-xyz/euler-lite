<script setup lang="ts">
import type { ActivityCategory, ActivityEvent, LiquidationRecord } from '@eulerxyz/euler-v2-sdk'
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
  getActivityLiquidationDisplayDetails,
  getActivityResolvableVaultAddresses,
  getPortfolioActivityPositionParticipant,
  resolveActivityVaultDisplay,
} from '~/utils/activity-display'

const { event, showVault = false, hideCategory = false, hideTimestamp = false, grouped = false, hiddenCategory, showTransactionLink = true, nowMs, liquidationDetails } = defineProps<{
  event: ActivityEvent
  showVault?: boolean
  /** Portfolio groups make the category redundant, while vault filters may still need it. */
  hideCategory?: boolean
  /** Transaction groups own their shared timestamp instead of repeating it on every event. */
  hideTimestamp?: boolean
  /** Applies the tighter visual treatment used inside transaction groups. */
  grouped?: boolean
  /** Category already implied by the active filter — omitted from the row to avoid restating it. */
  hiddenCategory?: ActivityCategory
  /** Composite portfolio operations link the transaction once at group level. */
  showTransactionLink?: boolean
  /** Feed-owned reactive clock shared by every visible event row. */
  nowMs: number
  /** Matching historical valuation record — enriches liquidation rows only. */
  liquidationDetails?: LiquidationRecord
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

// Resolve registry metadata for every vault address the row may render —
// collateral vaults, share tokens, and vault-typed governance change fields —
// so none of them fall back to a raw shortened address.
const metadataVaultAddresses = computed(() => getActivityResolvableVaultAddresses(event))

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

// Historical liquidation valuations resolve the collateral symbol from the
// token list first, then from the seized collateral vault's registry asset.
const liquidationDisplay = computed(() => {
  if (!liquidationDetails || event.type !== 'liquidation') return null
  void registryVersion.value
  return getActivityLiquidationDisplayDetails(liquidationDetails, (address) => {
    const token = tokenMetadata(address)
    if (token) return token
    const vaultAsset = getRegistryVault(liquidationDetails.collateral)?.asset
    return vaultAsset && vaultAsset.address.toLowerCase() === address.toLowerCase()
      ? vaultAsset
      : undefined
  })
})
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
    const converted = enriched.kind === 'collateral'
      ? liquidationDisplay.value?.collateralAmount
      : undefined
    const amount = converted ?? formatActivityAssetAmount(enriched, event.type)
    // Portfolio event verbs already communicate direction. Signs there make
    // borrow/repay read backwards, while vault history still benefits from
    // explicit inflow/outflow direction.
    const signed = !showVault && amount !== 'Amount unavailable' && direction
    // Once converted to underlying units the quantity is no longer in shares.
    const label = converted
      ? 'Collateral seized'
      : getActivityAssetLabel(enriched.kind, event.category, event.type)
    return {
      kind: 'asset' as const,
      address: enriched.address,
      amount: signed ? `${direction === 'in' ? '+' : '−'}${amount}` : amount,
      amountClass: signed && direction === 'in' ? 'text-accent-600' : 'text-content-primary',
      amountTitle: amount === 'Amount unavailable' ? `Raw units: ${enriched.amountRaw}` : undefined,
      avatarAsset: showVault && event.category !== 'liquidations'
        ? null
        : resolveAvatarAsset(enriched),
      key: `asset:${enriched.kind}:${enriched.address ?? 'unknown'}:${index}`,
      // The generic "Assets" label restates what the amount already shows —
      // keep only informative labels (Allowance, Debt repaid, …).
      label: label === 'Assets' ? undefined : label,
      usd: formatActivityAssetUsd(enriched)
        ?? (enriched.kind === 'assets'
          ? liquidationDisplay.value?.repayUsd
          : liquidationDisplay.value?.collateralUsd)
        ?? null,
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
// The seized collateral vault trails the numbers as its own metadata line, so
// the amounts and the bonus read uninterrupted.
const collateralVaultEntry = computed(() => {
  if (event.category !== 'liquidations') return null
  const address = event.assets?.find(asset => asset.kind === 'collateral')?.address
  if (!address) return null
  void registryVersion.value
  const display = resolveActivityVaultDisplay(address, getRegistryVault, collateralProduct.name)
  return {
    kind: 'address' as const,
    key: 'collateral-vault',
    label: undefined,
    inlineLabel: getActivityAssetAddressLabel('collateral', event.category),
    address,
    addressLabel: display?.name,
    addressLinkKind: display ? 'vault' as const : undefined,
    addressVaultType: getRegistryVaultType(address),
  }
})
const valuation = computed(() => formatActivityValuationForAssets(event.valuation, event.assets ?? []))
const details = computed(() => [
  ...assets.value,
  ...(liquidationDisplay.value?.bonusUsd
    ? [{
        kind: 'valuation' as const,
        key: 'liquidation-bonus',
        label: 'Liquidator bonus',
        value: liquidationDisplay.value.bonusUsd,
        valueClass: liquidationDisplay.value.bonusTone === 'positive'
          ? 'text-accent-600'
          : liquidationDisplay.value.bonusTone === 'negative'
            ? 'text-error-500'
            : undefined,
        valueTitle: 'Collateral seized minus debt repaid, valued at the liquidation',
        addresses: undefined,
      }]
    : []),
  ...changes.value,
  ...(collateralVaultEntry.value ? [collateralVaultEntry.value] : []),
  ...(valuation.value
    ? [{
        kind: 'valuation' as const,
        key: 'valuation',
        label: 'USD value',
        value: valuation.value,
        valueClass: undefined,
        valueTitle: event.valuation?.reason,
        addresses: undefined,
      }]
    : []),
])
const portfolioPosition = computed(() => showVault
  ? getPortfolioActivityPositionParticipant(event)
  : null)
// Collapsing behind a toggle only pays off when it hides more than one row —
// with exactly two entries, showing both is shorter than the button.
const COLLAPSED_ENTRY_COUNT = 2
const hiddenEntryCount = computed(() =>
  Math.max(0, details.value.length - COLLAPSED_ENTRY_COUNT))
const hasExpandableMobileDetails = computed(() => hiddenEntryCount.value > 0)
const eventIcon = computed(() => getActivityEventIcon(event))
const eventLabel = computed(() => portfolioPosition.value
  ? `${portfolioPosition.value.label} liquidated`
  : formatActivityEventLabel(event))
const { getPositionBySubAccountIndex } = useEulerAccount()
// A fully liquidated (closed) position no longer renders on /position/:n —
// only link while the position still exists.
const positionRoute = computed(() => portfolioPosition.value
  && getPositionBySubAccountIndex(portfolioPosition.value.index)
  ? { path: `/position/${portfolioPosition.value.index}`, query: route.query }
  : null)
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
  // `event.vaultType` is optional on SDK events — prefer what the registry
  // knows so Earn vaults never route to the lend page.
  const vaultType = getRegistryVaultType(display.address) ?? event.vaultType
  return {
    ...display,
    vault,
    route: {
      path: vaultType === 'earn' ? `/earn/${display.address}` : `/lend/${display.address}`,
      query: { network: route.query.network },
    },
  }
})
</script>

<template>
  <li
    class="activity-event-row relative -mx-12 grid items-center gap-10 rounded-8 border-b border-line-subtle px-12 py-12 transition-colors last:border-b-0 hover:bg-card-hover"
    :class="{
      'activity-event-row--grouped': grouped,
      'activity-event-row--portfolio': showVault,
    }"
  >
    <div
      v-if="!showVault"
      class="activity-event-row__icon flex h-32 w-32 shrink-0 items-center justify-center rounded-full bg-surface text-content-secondary"
    >
      <SvgIcon
        :name="eventIcon.name"
        class="!h-18 !w-18"
        aria-hidden="true"
      />
    </div>
    <div class="activity-event-row__title min-w-0 pr-48">
      <div
        v-if="vaultDisplay"
        class="mb-4 min-w-0"
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
            size="small"
          />
          <span
            v-else
            class="truncate text-p4 text-content-secondary hover:text-accent-500 hover:underline"
          >
            {{ vaultDisplay.name || vaultDisplay.addressLabel }}
          </span>
        </NuxtLink>
      </div>
      <div
        class="activity-event-row__event-summary"
        :class="{ 'activity-event-row__event-summary--with-vault': showVault && vaultDisplay?.vault }"
      >
        <NuxtLink
          v-if="positionRoute"
          :to="positionRoute"
          class="line-clamp-2 break-words text-p2 font-medium text-content-primary"
          :title="eventLabel"
        >
          {{ eventLabel }}
        </NuxtLink>
        <div
          v-else
          class="line-clamp-2 break-words text-p2 font-medium text-content-primary"
          :title="eventLabel"
        >
          {{ eventLabel }}
        </div>
        <div class="activity-event-row__meta mt-2 flex flex-wrap items-center gap-x-8 gap-y-2 text-p4 text-content-tertiary">
          <span
            v-if="showVault && !hideTimestamp"
            aria-hidden="true"
          >&middot;</span>
          <template v-if="!hideCategory && event.category !== hiddenCategory">
            <span>{{ getActivityCategoryLabel(event.category) }}</span>
            <span
              v-if="!hideTimestamp"
              aria-hidden="true"
            >&middot;</span>
          </template>
          <time
            v-if="!hideTimestamp"
            class="whitespace-nowrap"
            :datetime="event.timestamp"
            :title="formatActivityTimestamp(event.timestamp)"
          >{{ formatActivityRelativeTimestamp(event.timestamp, nowMs) }}</time>
        </div>
      </div>
    </div>

    <div
      class="activity-event-row__details flex min-w-0 flex-col gap-6 pl-40"
      :class="{ 'activity-event-row__details--with-vault': showVault && vaultDisplay?.vault }"
    >
      <div
        v-for="(detail, index) in details"
        :key="detail.key"
        class="min-w-0"
        :class="index >= COLLAPSED_ENTRY_COUNT && !expanded ? 'activity-event-row__secondary-detail hidden' : ''"
      >
        <div
          v-if="detail.label"
          class="text-p4 text-content-tertiary"
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
            <div
              class="min-w-0 break-words text-p3 font-medium"
              :class="detail.amountClass"
              :title="detail.amountTitle"
            >
              {{ detail.amount }}
              <span
                v-if="detail.usd"
                class="whitespace-nowrap text-p4 font-normal text-content-tertiary"
              >&middot; {{ detail.usd }}</span>
            </div>
          </div>
        </template>

        <div
          v-else-if="detail.kind === 'address'"
          class="activity-event-row__asset-address flex min-w-0 items-center gap-4 text-p4"
        >
          <span class="shrink-0 text-content-tertiary">{{ detail.inlineLabel }}</span>
          <ActivityAddress
            :address="detail.address"
            :chain-id="event.chainId"
            :label="detail.addressLabel"
            :link-kind="detail.addressLinkKind"
            :vault-type="detail.addressVaultType"
          />
        </div>

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
            class="break-words text-p3"
            :class="detail.kind === 'valuation' && detail.valueClass ? detail.valueClass : 'text-content-primary'"
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
/* Stacked (narrow) layout: icon + title on the first line, details as
   full-width lines underneath. */
.activity-event-row {
  grid-template-columns: 32px minmax(0, 1fr);
}

.activity-event-row--portfolio {
  grid-template-columns: minmax(0, 1fr);
}

.activity-event-row--grouped {
  border-radius: 0;
  padding-top: 10px;
  padding-bottom: 10px;
}

.activity-event-row--portfolio .activity-event-row__event-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 6px;
}

/* Indent the verb and stacked details to the identity text (32px avatar +
   10px gap). */
.activity-event-row--portfolio .activity-event-row__event-summary--with-vault,
.activity-event-row--portfolio .activity-event-row__details--with-vault {
  padding-left: 42px;
}

.activity-event-row--portfolio .activity-event-row__meta {
  margin-top: 0;
  column-gap: 6px;
}

.activity-event-row__details {
  grid-column: 1 / -1;
}

@container activity-feed (min-width: 520px) {
  /* One rule for every row: the icon, details column, and transaction link
     center against the full card height beside the title line. */
  .activity-event-row {
    grid-template-columns: 32px minmax(200px, 1.4fr) minmax(180px, 1fr) 40px;
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

  .activity-event-row--portfolio {
    grid-template-columns: minmax(220px, 1.4fr) minmax(200px, 1fr) 40px;
  }

  .activity-event-row--portfolio .activity-event-row__title {
    grid-column: 1;
  }

  .activity-event-row--portfolio .activity-event-row__details {
    grid-column: 2;
    padding-left: 0;
  }

  /* Details live in their own column here — the stacked-layout indent would
     only waste width. */
  .activity-event-row--portfolio .activity-event-row__details--with-vault {
    padding-left: 0;
  }

  .activity-event-row--portfolio .activity-event-row__transaction {
    grid-column: 3;
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
      minmax(320px, 1.4fr)
      minmax(280px, 1fr)
      44px;
  }

  /* Events carry two text lines against a short amount — give them the
     larger share so the amount column doesn't trail off into dead space. */
  .activity-event-row--portfolio {
    grid-template-columns:
      minmax(320px, 1.4fr)
      minmax(280px, 1fr)
      44px;
  }

  .activity-event-row__secondary-detail {
    display: block;
  }

  .activity-event-row__more {
    display: none;
  }

  .activity-event-row__asset-amount,
  .activity-event-row__asset-address {
    margin-top: 2px;
  }
}
</style>
