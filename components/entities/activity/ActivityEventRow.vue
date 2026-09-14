<script setup lang="ts">
import type { ActivityCategory, ActivityEvent, LiquidationRecord } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getExplorerLink } from '~/utils/block-explorer'
import { fetchVaultCategory } from '~/utils/vault/categories'
import {
  getActivityAddressCollectionSummary,
  getActivityLiquidationBonusEntry,
} from '~/components/entities/activity/activityEventRowDetails'
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
const { buildKnownSymbols, resolveSymbol: resolveTokenSymbol } = useTokenSymbolResolver()
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

// Factory membership gates the registry fetch: addresses the vault resolver
// doesn't recognize as Euler vaults (e.g. an external ERC-4626 configured as
// a router resolved vault) skip the registry's on-chain fetch fallback and
// deterministically render as their raw token symbol instead.
watch(metadataVaultAddresses, (addresses) => {
  for (const address of addresses) {
    void fetchVaultCategory(address).then((category) => {
      if (category) void getOrFetchRegistryVault(address)
    })
  }
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

const knownTokenSymbols = computed(() => {
  void registryVersion.value
  return buildKnownSymbols()
})

const activityTokenSymbol = (address: `0x${string}`) =>
  tokenMetadata(address)?.symbol
  ?? resolveTokenSymbol(address, knownTokenSymbols.value)

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
  }, (address) => {
    const debtVault = getRegistryVault(liquidationDetails.vault)
    const debtVaultUnitOfAccount = debtVault && 'unitOfAccount' in debtVault
      ? debtVault.unitOfAccount
      : undefined
    if (
      debtVaultUnitOfAccount
      && debtVaultUnitOfAccount.address.toLowerCase() === address.toLowerCase()
    ) {
      return debtVaultUnitOfAccount.symbol
    }
    const unitOfAccountVault = getRegistryVault(address)
    return unitOfAccountVault?.shares?.symbol
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
  return getActivityChangeEntries(event, activityVaultMetadata, activityTokenSymbol)
    .filter(entry => event.category !== 'liquidations' || entry.field !== 'collateral')
    .map(entry => ({
      kind: 'change' as const,
      key: `change:${entry.field}`,
      label: entry.label,
      value: entry.value,
      valueTitle: entry.value,
      summary: entry.summary,
      addresses: entry.addresses,
      addressDetails: entry.addressDetails,
      avatarAssets: entry.field === 'asset_pair'
        || (event.type === 'set_resolved_vault' && entry.field === 'asset')
        ? entry.addresses?.map(address => ({
            address: address.address,
            symbol: address.label ?? '',
          }))
        : undefined,
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
    label: getActivityAssetAddressLabel('collateral', event.category),
    inlineLabel: undefined,
    address,
    addressLabel: display?.name,
    addressLinkKind: display ? 'vault' as const : undefined,
    addressVaultType: getRegistryVaultType(address),
  }
})
const valuation = computed(() => formatActivityValuationForAssets(event.valuation, event.assets ?? []))
const liquidationBonusEntry = computed(() =>
  getActivityLiquidationBonusEntry(liquidationDisplay.value))
const details = computed(() => [
  ...assets.value,
  ...(liquidationBonusEntry.value ? [liquidationBonusEntry.value] : []),
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
// Keep the default row scannable: the primary amount/change stays visible and
// secondary liquidation or governance detail is available on demand.
const COLLAPSED_ENTRY_COUNT = 1
const hiddenEntryCount = computed(() =>
  Math.max(0, details.value.length - COLLAPSED_ENTRY_COUNT))
const addressCollectionSummary = (detail: (typeof details.value)[number]) =>
  'summary' in detail && detail.summary
    ? detail.summary
    : getActivityAddressCollectionSummary(event.type, detailAddressCount(detail))
const detailAddressCount = (detail: (typeof details.value)[number]) =>
  'addresses' in detail && Array.isArray(detail.addresses) ? detail.addresses.length : 0
const hasExpandableDetails = computed(() =>
  hiddenEntryCount.value > 0
  || details.value
    .slice(0, COLLAPSED_ENTRY_COUNT)
    .some(detail => addressCollectionSummary(detail) !== null))
const eventIcon = computed(() => getActivityEventIcon(event))
const eventLabel = computed(() => portfolioPosition.value
  ? `${portfolioPosition.value.label} liquidated`
  : formatActivityEventLabel(event))
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
      'activity-event-row--expanded': expanded,
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
        <div
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
      :class="{
        'activity-event-row__details--with-vault': showVault && vaultDisplay?.vault,
        'activity-event-row__details--expanded': expanded,
      }"
    >
      <div
        v-for="(detail, index) in details"
        :key="detail.key"
        class="activity-event-row__detail min-w-0"
        :class="[
          index >= COLLAPSED_ENTRY_COUNT && !expanded ? 'activity-event-row__secondary-detail hidden' : '',
          detailAddressCount(detail) ? 'activity-event-row__detail--address-list' : '',
          detail.key === 'change:asset_pair' ? 'activity-event-row__detail--asset-pair' : '',
        ]"
      >
        <div
          v-if="detail.label"
          class="activity-event-row__detail-label text-p4 text-content-tertiary"
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
          <span
            v-if="detail.inlineLabel"
            class="shrink-0 text-content-tertiary"
          >{{ detail.inlineLabel }}</span>
          <ActivityAddress
            :address="detail.address"
            :chain-id="event.chainId"
            :label="detail.addressLabel"
            :link-kind="detail.addressLinkKind"
            :vault-type="detail.addressVaultType"
            compact-vault
          />
        </div>

        <template v-else>
          <template v-if="detail.addresses?.length">
            <div
              v-if="!expanded && addressCollectionSummary(detail)"
              class="mt-2 flex min-w-0 items-center gap-8"
            >
              <AssetAvatar
                v-if="'avatarAssets' in detail && detail.avatarAssets?.length"
                :asset="detail.avatarAssets"
                size="20"
                class="shrink-0"
              />
              <span class="min-w-0 break-words text-p3 text-content-primary">
                {{ addressCollectionSummary(detail) }}
              </span>
            </div>
            <div
              v-else
              class="activity-event-row__detail-addresses mt-2 flex min-w-0 flex-col items-start gap-2 text-p3"
            >
              <div
                v-for="(address, addressIndex) in detail.addresses"
                :key="`${address.address}:${addressIndex}`"
                class="flex w-full min-w-0 flex-wrap items-center gap-x-8 gap-y-2"
              >
                <AssetAvatar
                  v-if="'avatarAssets' in detail && detail.avatarAssets?.[addressIndex]"
                  :asset="detail.avatarAssets[addressIndex]"
                  size="20"
                  class="shrink-0"
                />
                <ActivityAddress
                  :address="address.address"
                  :chain-id="event.chainId"
                  :label="address.label"
                  :link-kind="address.linkKind"
                  :vault-type="address.vaultType"
                  compact-vault
                />
                <span
                  v-if="'addressDetails' in detail && detail.addressDetails?.[addressIndex]"
                  class="text-p4 text-content-secondary"
                >{{ detail.addressDetails[addressIndex] }}</span>
              </div>
            </div>
          </template>
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
        v-if="hasExpandableDetails"
        type="button"
        class="activity-event-row__more inline-flex w-fit items-center gap-4 text-p4 text-content-tertiary transition-colors hover:text-content-primary"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? 'Hide' : 'Show'} additional ${eventLabel} details`"
        @click="expanded = !expanded"
      >
        <span>{{ expanded ? 'Less' : 'More' }}</span>
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

.activity-event-row__details--expanded .activity-event-row__detail:not(.hidden) {
  width: 100%;
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
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 12px;
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
    margin-top: 0;
  }

  .activity-event-row__detail:not(.hidden) {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  .activity-event-row__details:not(.activity-event-row__details--expanded) .activity-event-row__detail-addresses {
    margin-top: 0;
    flex-direction: row;
  }

  .activity-event-row__details--expanded {
    flex-direction: column;
    align-items: flex-start;
    flex-wrap: nowrap;
    gap: 10px;
  }
}

@container activity-feed (min-width: 700px) {
  .activity-event-row--portfolio.activity-event-row--expanded {
    grid-template-columns:
      minmax(220px, 1fr)
      minmax(320px, 1.2fr)
      40px;
  }

  .activity-event-row__details--expanded .activity-event-row__detail:not(.hidden) {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    align-items: center;
    column-gap: 12px;
  }

  /* Multi-row values such as oracle asset pairs should start beside their
     label instead of centering the label between the two assets. */
  .activity-event-row__details--expanded .activity-event-row__detail--address-list:not(.hidden) {
    align-items: start;
  }

  .activity-event-row__details--expanded .activity-event-row__detail--address-list .activity-event-row__detail-label {
    padding-top: 2px;
  }

  .activity-event-row__details--expanded .activity-event-row__detail--address-list .activity-event-row__detail-addresses {
    margin-top: 0;
  }

  .activity-event-row__details--expanded .activity-event-row__detail > :not(.activity-event-row__detail-label) {
    grid-column: 2;
  }

  .activity-event-row__details--expanded .activity-event-row__more {
    margin-left: 142px;
    margin-top: 2px;
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

  .activity-event-row__asset-amount,
  .activity-event-row__asset-address {
    margin-top: 0;
  }

  .activity-event-row__details--expanded .activity-event-row__detail:not(.hidden) {
    grid-template-columns: 150px minmax(0, 1fr);
  }

  .activity-event-row__details--expanded .activity-event-row__more {
    margin-left: 162px;
    margin-top: 2px;
  }
}

.activity-event-row__details--expanded .activity-event-row__detail--asset-pair:not(.hidden) {
  display: block;
}

.activity-event-row__details--expanded .activity-event-row__detail--asset-pair .activity-event-row__detail-label {
  padding-top: 0;
}

.activity-event-row__details--expanded .activity-event-row__detail--asset-pair .activity-event-row__detail-addresses {
  margin-top: 2px;
}
</style>
