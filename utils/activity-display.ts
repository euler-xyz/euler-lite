import type {
  ActivityAssetAmount,
  ActivityAssetKind,
  ActivityCategory,
  ActivityChangeValue,
  ActivityCoverageStatus,
  ActivityEvent,
  ActivityValuation,
  ActivityVaultType,
  LiquidationRecord,
} from '@eulerxyz/euler-v2-sdk'
import { formatUnits, isAddress, maxUint256, zeroAddress, type Address } from 'viem'
import { formatCompactUsdValue, formatSmartAmount, shortenAddress } from '~/utils/string-utils'
import { CFG_DONT_SOCIALIZE_DEBT } from '~/entities/constants'
import { decodeHookedOperationsMask, getHookedOperationMetas } from '~/utils/vault-hooks'
import { getSpecialAddressLabel } from '~/utils/special-addresses'

interface ActivityTokenMetadata {
  address: Address
  name?: string
  symbol: string
  decimals: number
}

interface ActivityVaultMetadata {
  asset?: ActivityTokenMetadata
  shares?: ActivityTokenMetadata
  vaultType?: ActivityVaultType
}

interface ActivityAssetContext {
  category: ActivityCategory
  vault?: Address
}

type ActivityVaultMetadataLookup = (address: Address) => ActivityVaultMetadata | undefined
type ActivityTokenMetadataLookup = (address: Address) => ActivityTokenMetadata | undefined
type ActivityAddressLabelLookup = (address: Address) => string | undefined

export interface ActivityVaultDisplay {
  address: Address
  addressLabel: string
  name?: string
}

/**
 * Resolves position-history market context from Euler Labels and the vault
 * registry. The address remains visible so markets with the same name are
 * still distinguishable.
 */
export const resolveActivityVaultDisplay = (
  vaultAddress: Address | undefined,
  getVaultMetadata: ActivityVaultMetadataLookup,
  productName?: string,
): ActivityVaultDisplay | null => {
  if (!vaultAddress) return null

  const name = productName?.trim()
    || getVaultMetadata(vaultAddress)?.shares?.name?.trim()
    || undefined
  const addressLabel = shortenAddress(vaultAddress)
  return {
    address: vaultAddress,
    addressLabel,
    ...(name ? { name } : {}),
  }
}

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  lending: 'Lending',
  borrowing: 'Borrowing',
  swaps: 'Swaps',
  liquidations: 'Liquidations',
  account: 'Position',
  rewards: 'Rewards',
  governance: 'Governance',
}

const ACCOUNT_ACTIVITY_EVENT_TYPES = [
  'deposit',
  'withdraw',
  'borrow',
  'repay',
  'pull_debt',
  'liquidation',
] as const satisfies readonly ActivityEvent['type'][]

const VAULT_ACTIVITY_EVENT_TYPES = {
  evk: [
    'deposit',
    'withdraw',
    'transfer',
    'borrow',
    'repay',
    'debt_socialized',
    'pull_debt',
    'liquidation',
    'approval',
    'balance_forwarder_status',
    'convert_fees',
    'set_caps',
    'set_ltv',
    'set_governor_admin',
    'set_config_flags',
    'set_fee_receiver',
    'set_hook_config',
    'set_interest_fee',
    'set_interest_rate_model',
    'set_liquidation_cool_off_time',
    'set_max_liquidation_discount',
  ],
  earn: [
    'deposit',
    'withdraw',
    'transfer',
    'reallocate_supply',
    'reallocate_withdraw',
    'set_name',
    'set_symbol',
    'set_fee',
    'set_fee_recipient',
    'set_curator',
    'set_guardian',
    'set_timelock',
    'set_cap',
    'set_is_allocator',
    'set_supply_queue',
    'set_withdraw_queue',
    'submit_cap',
    'submit_guardian',
    'submit_timelock',
    'submit_market_removal',
    'revoke_pending_cap',
    'revoke_pending_guardian',
    'revoke_pending_timelock',
    'revoke_pending_market_removal',
    'ownership_transfer_started',
    'ownership_transferred',
    'public_reallocate_to',
    'public_withdrawal',
    'set_admin',
    'set_allocation_fee',
    'set_flow_caps',
    'transfer_allocation_fee',
  ],
  securitize: [
    'deposit',
    'withdraw',
    'transfer',
    'approval',
    'seized',
    'frozen',
    'unfrozen',
    'paused',
    'unpaused',
    'set_controller_perspective',
    'set_governor_admin',
    'set_supply_cap',
  ],
} as const satisfies Record<ActivityVaultType, readonly ActivityEvent['type'][]>

type ActivityDisplayScope
  = | { kind: 'account' }
    | { kind: 'vault', vaultType: ActivityVaultType }

export const getDisplayActivityEventTypes = (
  scope: ActivityDisplayScope,
): readonly ActivityEvent['type'][] =>
  scope.kind === 'account'
    ? ACCOUNT_ACTIVITY_EVENT_TYPES
    : VAULT_ACTIVITY_EVENT_TYPES[scope.vaultType]

export const filterActivityEventsForDisplay = (
  events: readonly ActivityEvent[],
  eventTypes: readonly ActivityEvent['type'][],
  { hideZeroLiquidations = false }: { hideZeroLiquidations?: boolean } = {},
): ActivityEvent[] => {
  const displayEventTypes = new Set<string>(eventTypes)
  const hasMeaningfulLiquidationAmount = (event: ActivityEvent) => {
    if (event.type !== 'liquidation') return true

    const relevantAssets = event.assets?.filter(asset =>
      asset.kind === 'assets' || asset.kind === 'collateral',
    ) ?? []
    if (relevantAssets.length === 0) return true

    return relevantAssets.some((asset) => {
      try {
        return BigInt(asset.amountRaw) !== 0n
      }
      catch {
        // Keep malformed/unknown values visible rather than silently losing
        // potentially meaningful history.
        return true
      }
    })
  }
  const visibleEvents = events.filter(event =>
    displayEventTypes.has(event.type)
    && (!hideZeroLiquidations || hasMeaningfulLiquidationAmount(event)),
  )
  const pairedTypes = new Set<ActivityEvent['type']>([
    'deposit',
    'withdraw',
    'liquidation',
    'reallocate_supply',
    'reallocate_withdraw',
    'public_reallocate_to',
    'public_withdrawal',
  ])

  const sameTransaction = (left: ActivityEvent, right: ActivityEvent) =>
    left.chainId === right.chainId
    && left.txHash.toLowerCase() === right.txHash.toLowerCase()

  const sameAddress = (left: string | undefined, right: string | undefined) =>
    left !== undefined
    && right !== undefined
    && left.toLowerCase() === right.toLowerCase()

  const getLiquidationViolator = (event: ActivityEvent) => {
    const payloadViolator = event.payload.violator
    return typeof payloadViolator === 'string'
      ? payloadViolator
      : event.counterparty
  }

  const hasMatchingAssetAmount = (left: ActivityEvent, right: ActivityEvent) => {
    const leftAssets = left.assets?.filter(asset => asset.kind === 'assets') ?? []
    const rightAssets = right.assets?.filter(asset => asset.kind === 'assets') ?? []
    return leftAssets.some((leftAsset) => {
      const leftAddress = leftAsset.address ?? left.vault
      if (!leftAddress || leftAsset.amountRaw === undefined) return false
      return rightAssets.some((rightAsset) => {
        const rightAddress = rightAsset.address ?? right.vault
        return rightAddress !== undefined
          && rightAsset.amountRaw !== undefined
          && leftAddress.toLowerCase() === rightAddress.toLowerCase()
          && leftAsset.amountRaw === rightAsset.amountRaw
      })
    })
  }

  return visibleEvents.filter((event) => {
    if (event.type === 'repay') {
      return !events.some(candidate =>
        candidate.type === 'liquidation'
        && sameTransaction(event, candidate)
        && sameAddress(event.account, getLiquidationViolator(candidate))
        && hasMatchingAssetAmount(event, candidate),
      )
    }

    if (event.type !== 'transfer') return true

    const shareMovements = event.assets?.filter(asset => asset.kind === 'shares') ?? []
    if (shareMovements.length === 0) return true

    return !events.some((candidate) => {
      if (
        candidate.id === event.id
        || !sameTransaction(event, candidate)
        || !pairedTypes.has(candidate.type)
      ) return false

      return shareMovements.some((transferAsset) => {
        const transferAddress = transferAsset.address ?? event.vault
        if (!transferAddress) return false
        return candidate.assets?.some((candidateAsset) => {
          const candidateAddress = candidateAsset.address ?? candidate.vault
          return candidateAddress !== undefined
            && candidateAddress.toLowerCase() === transferAddress.toLowerCase()
            && candidateAsset.amountRaw === transferAsset.amountRaw
        }) ?? false
      })
    })
  })
}

export interface ActivityTransactionGroup {
  id: string
  chainId: number
  txHash: string
  timestamp: string
  events: ActivityEvent[]
}

export const getActivityTransactionGroupLabel = (
  group: Pick<ActivityTransactionGroup, 'events'>,
) => group.events.some(event => event.type === 'liquidation')
  ? 'Liquidation transaction'
  : 'Transaction'

export const groupActivityEventsByTransaction = (
  events: readonly ActivityEvent[],
): ActivityTransactionGroup[] => {
  const groups = new Map<string, ActivityTransactionGroup>()

  for (const event of events) {
    const id = `${event.chainId}:${event.txHash.toLowerCase()}`
    const existing = groups.get(id)
    if (existing) existing.events.push(event)
    else {
      groups.set(id, {
        id,
        chainId: event.chainId,
        txHash: event.txHash,
        timestamp: event.timestamp,
        events: [event],
      })
    }
  }

  return [...groups.values()]
}

export interface ActivityFilterOption {
  value: string
  label: string
  categories: readonly ActivityCategory[]
  /** Optional event count rendered after the label, e.g. "Liquidations (2)". */
  count?: number | string
}

export const resolveActivityFilterCategories = (
  options: readonly ActivityFilterOption[],
  selectedFilters: readonly string[],
): ActivityCategory[] => {
  const selected = new Set(selectedFilters)
  const activeOptions = selected.size === 0
    ? options
    : options.filter(option => selected.has(option.value))
  return [...new Set(activeOptions.flatMap(option => option.categories))].sort()
}

export const isActivityScopeUnsupported = (
  coverageStatus: ActivityCoverageStatus | undefined,
  selectedFilters: readonly string[],
): boolean => coverageStatus === 'unsupported' && selectedFilters.length === 0

const CATEGORY_ICONS: Record<ActivityCategory, string> = {
  lending: 'lend-outline',
  borrowing: 'borrow-outline',
  swaps: 'swap-horizontal',
  liquidations: 'warning',
  account: 'wallet',
  rewards: 'sparks',
  governance: 'governed',
}

export const getActivityCategoryLabel = (category: ActivityCategory): string =>
  CATEGORY_LABELS[category]

export const getActivityCategoryIcon = (category: ActivityCategory): string =>
  CATEGORY_ICONS[category]

export const getVaultActivityFilterOptions = (
  vaultType: ActivityVaultType,
): ActivityFilterOption[] => {
  const lendingCategories: ActivityCategory[] = vaultType === 'evk'
    ? ['lending', 'borrowing']
    : ['lending']
  const options: ActivityFilterOption[] = [
    {
      value: vaultType === 'evk' ? 'lending-borrowing' : 'lending',
      label: vaultType === 'evk' ? 'Lending and borrowing' : 'Lending',
      categories: lendingCategories,
    },
    { value: 'governance', label: 'Governance', categories: ['governance'] },
  ]
  if (vaultType === 'evk') {
    options.push({ value: 'liquidations', label: 'Liquidations', categories: ['liquidations'] })
  }
  return options
}

export const getDefaultVaultActivityFilter = (
  vaultType: ActivityVaultType,
): string => vaultType === 'evk' ? 'lending-borrowing' : 'lending'

// The `account` category (controller/collateral/operator status, ToS
// signatures, …) is deliberately absent: none of its event types are
// displayed on Lite, so querying it would only surface empty results.
const ACCOUNT_ACTIVITY_CATEGORIES = [
  'lending',
  'borrowing',
  'liquidations',
] as const satisfies readonly ActivityCategory[]

/** Categories the unfiltered portfolio feed queries. */
export const getAccountActivityCategories = (): readonly ActivityCategory[] =>
  ACCOUNT_ACTIVITY_CATEGORIES

/**
 * The portfolio chip row exposes only liquidations: event verbs and
 * transaction grouping already communicate lending/borrowing, while "was I
 * ever liquidated?" deserves a one-click answer.
 */
export const getAccountActivityFilterOptions = (): ActivityFilterOption[] => [
  {
    value: 'liquidations',
    label: getActivityCategoryLabel('liquidations'),
    categories: ['liquidations'],
  },
]

const applyActivityAcronyms = (label: string): string => label
  .replace(/\bltv\b/gi, 'LTV')
  .replace(/\birm\b/gi, 'IRM')
  .replace(/\busd\b/gi, 'USD')

export const titleizeActivityType = (type: string): string => {
  const words = type
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Activity'
}

type ActivityEventLabelSource = {
  label?: string
  type: string
  account?: Address
  payload?: Record<string, unknown>
}

export type ActivityTransferDirection = 'received' | 'sent' | 'unknown'

export const getActivityTransferDirection = (
  event: Pick<ActivityEventLabelSource, 'account' | 'payload' | 'type'>,
): ActivityTransferDirection => {
  if (event.type !== 'transfer' || !event.account) return 'unknown'
  const account = event.account.toLowerCase()
  const from = typeof event.payload?.from === 'string' ? event.payload.from.toLowerCase() : undefined
  const to = typeof event.payload?.to === 'string' ? event.payload.to.toLowerCase() : undefined
  if (from === account && to !== account) return 'sent'
  if (to === account && from !== account) return 'received'
  return 'unknown'
}

export const formatActivityEventLabel = (
  event: ActivityEventLabelSource,
): string => {
  const sourceLabel = event.label?.trim()
  if (sourceLabel) return sourceLabel
  if (event.type === 'transfer') {
    const direction = getActivityTransferDirection(event)
    if (direction === 'sent') return 'Vault shares sent'
    if (direction === 'received') return 'Vault shares received'
    return 'Vault shares transferred'
  }
  return applyActivityAcronyms(titleizeActivityType(event.type))
}

export interface ActivityEventIcon {
  name: string
}

const OUTFLOW_EVENT_TYPES: readonly string[] = ['withdraw', 'borrow', 'reallocate_withdraw', 'public_withdrawal']
const INFLOW_EVENT_TYPES: readonly string[] = ['deposit', 'repay', 'reallocate_supply', 'public_reallocate_to']

export type ActivityAmountDirection = 'in' | 'out'

/**
 * Direction of the asset flow relative to the vault: `in` for events that add
 * assets (deposit, repay), `out` for events that remove them (withdraw,
 * borrow). Undefined when the event has no clear single direction.
 */
export const getActivityAmountDirection = (
  event: Pick<ActivityEventLabelSource, 'account' | 'payload' | 'type'>,
): ActivityAmountDirection | undefined => {
  if (event.type === 'transfer') {
    const direction = getActivityTransferDirection(event)
    if (direction === 'sent') return 'out'
    if (direction === 'received') return 'in'
    return undefined
  }
  if (OUTFLOW_EVENT_TYPES.includes(event.type)) return 'out'
  if (INFLOW_EVENT_TYPES.includes(event.type)) return 'in'
  return undefined
}

export const getActivityEventIcon = (
  event: Pick<ActivityEventLabelSource, 'account' | 'payload' | 'type'> & { category: ActivityCategory },
): ActivityEventIcon => {
  const direction = getActivityAmountDirection(event)
  if (direction === 'out') return { name: 'borrow-outline' }
  if (direction === 'in') return { name: 'lend-outline' }
  if (event.type === 'transfer') return { name: 'swap-horizontal' }
  return { name: getActivityCategoryIcon(event.category) }
}

export const formatActivityTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '-'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

/**
 * Compact relative feed timestamp, used consistently across the vault and
 * portfolio feeds. The full absolute timestamp stays available via
 * `formatActivityTimestamp` (rendered as the hover title). Future timestamps
 * (clock skew) fall back to the absolute date.
 */
export const formatActivityRelativeTimestamp = (
  timestamp: string,
  nowMs: number = Date.now(),
): string => {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return '-'
  const elapsedMs = nowMs - date.getTime()
  if (elapsedMs < 0) {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date)
  }
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} mo ago`
  return `${Math.max(1, Math.floor(days / 365))} y ago`
}

const resolveAssetAmount = (asset: ActivityAssetAmount): string | undefined => {
  if (asset.amount !== undefined && asset.amount.trim()) return asset.amount
  if (asset.amountRaw === undefined || asset.decimals === undefined) return undefined
  try {
    return formatUnits(BigInt(asset.amountRaw), asset.decimals)
  }
  catch {
    return undefined
  }
}

export const formatActivityAssetAmount = (
  asset: ActivityAssetAmount,
  eventType?: ActivityEvent['type'],
): string => {
  if (eventType === 'approval') {
    try {
      const allowance = BigInt(asset.amountRaw)
      if (allowance === maxUint256) return 'Unlimited'
      if (allowance === 0n) return 'Revoked'
    }
    catch {
      return 'Amount unavailable'
    }
  }
  const amount = resolveAssetAmount(asset)
  if (amount === undefined) return 'Amount unavailable'
  const formatted = formatSmartAmount(amount)
  return asset.symbol ? `${formatted} ${asset.symbol}` : formatted
}

/**
 * Routine activity displays underlying asset units and omits share movements.
 * Liquidations also expose the collateral quantity — shown as shares until the
 * historical underlying conversion arrives from `/v3/liquidations`.
 */
export const getActivityAssetsForDisplay = (
  event: Pick<ActivityEvent, 'assets' | 'category'>,
): ActivityAssetAmount[] => (event.assets ?? []).filter(asset =>
  asset.kind === 'assets'
  || (event.category === 'liquidations' && asset.kind === 'collateral'),
)

/**
 * Fills display-only token metadata from Lite's existing vault registry.
 * Fields supplied by the activity source always win, and historical USD value
 * remains source-owned.
 */
export const enrichActivityAssetForDisplay = (
  asset: ActivityAssetAmount,
  event: ActivityAssetContext,
  getVaultMetadata: ActivityVaultMetadataLookup,
  getTokenMetadata?: ActivityTokenMetadataLookup,
): ActivityAssetAmount => {
  let token: ActivityTokenMetadata | undefined

  if (asset.kind === 'assets' && event.vault) {
    token = getVaultMetadata(event.vault)?.asset
  }
  else if (asset.kind === 'shares') {
    const shareVault = asset.address ?? event.vault
    if (shareVault) token = getVaultMetadata(shareVault)?.shares
  }
  else if (
    event.category === 'liquidations'
    && (asset.kind === 'collateral' || asset.kind === 'yield')
    && asset.address
  ) {
    token = getVaultMetadata(asset.address)?.shares
  }

  if (!token && asset.address && getTokenMetadata) {
    token = getTokenMetadata(asset.address)
  }

  if (!token) return asset
  return {
    ...asset,
    address: asset.address ?? token.address,
    symbol: asset.symbol ?? token.symbol,
    decimals: asset.decimals ?? token.decimals,
  }
}

/**
 * Money-style USD for activity details: cents pad to two decimals below
 * $1000 ("$2.70", never "$2.7"), compact notation and the `<$0.01` forms
 * apply above and below those bounds.
 */
export const formatActivityUsd = (value: string | number): string => {
  const numeric = Number(value)
  const abs = Math.abs(numeric)
  if (!Number.isFinite(numeric) || abs >= 1000 || (abs > 0 && abs < 0.01)) {
    return formatCompactUsdValue(value)
  }
  return numeric < 0 ? `-$${abs.toFixed(2)}` : `$${abs.toFixed(2)}`
}

export const formatActivityAssetUsd = (asset: ActivityAssetAmount): string | null =>
  asset.amountUsd === undefined
    ? null
    : formatActivityUsd(asset.amountUsd)

export interface ActivityLiquidationDisplayDetails {
  /** Event-time USD value of the repaid debt. */
  repayUsd?: string
  /** Seized collateral converted to underlying units, with symbol when known. */
  collateralAmount?: string
  collateralUsd?: string
  /** Signed event-time bonus, preferring USD and otherwise using the protocol unit of account. */
  bonus?: string
  bonusTitle?: string
  /** Rendering tone for the signed bonus. Absent for a zero bonus. */
  bonusTone?: 'positive' | 'negative'
}

const formatActivitySignedUnitValue = (
  rawValue: string,
  decimals: number,
  denomination: string,
): Pick<ActivityLiquidationDisplayDetails, 'bonus' | 'bonusTone'> | null => {
  try {
    const value = BigInt(rawValue)
    const amount = formatSmartAmount(formatUnits(value < 0n ? -value : value, decimals))
    return {
      bonus: `${value > 0n ? '+' : value < 0n ? '−' : ''}${amount} ${denomination}`,
      ...(value > 0n
        ? { bonusTone: 'positive' as const }
        : value < 0n
          ? { bonusTone: 'negative' as const }
          : {}),
    }
  }
  catch {
    return null
  }
}

/**
 * Formats a `/v3/liquidations` record for display on the matching liquidation
 * event row. Every field is optional: the endpoint omits historical values it
 * cannot reconstruct, and missing pieces leave the event's own display as-is.
 */
export const getActivityLiquidationDisplayDetails = (
  record: LiquidationRecord,
  getTokenMetadata?: ActivityTokenMetadataLookup,
  getAddressLabel?: ActivityAddressLabelLookup,
): ActivityLiquidationDisplayDetails => {
  const details: ActivityLiquidationDisplayDetails = {}
  if (record.repayAssetsUsd !== undefined) {
    details.repayUsd = formatActivityUsd(record.repayAssetsUsd)
  }
  if (
    record.collateralAssets !== undefined
    && record.collateralAssetDecimals !== undefined
  ) {
    try {
      const amount = formatSmartAmount(
        formatUnits(BigInt(record.collateralAssets), record.collateralAssetDecimals),
      )
      const symbol = record.collateralAsset
        ? getTokenMetadata?.(record.collateralAsset)?.symbol
        : undefined
      details.collateralAmount = symbol ? `${amount} ${symbol}` : amount
    }
    catch {
      // Malformed conversion — keep the event's share-quantity display.
    }
  }
  if (record.collateralAssetsUsd !== undefined) {
    details.collateralUsd = formatActivityUsd(record.collateralAssetsUsd)
  }
  if (record.bonusUsd !== undefined) {
    // The bonus is the row's P&L figure — signed and toned like one.
    if (record.bonusUsd < 0) {
      details.bonus = `−${formatActivityUsd(Math.abs(record.bonusUsd))}`
      details.bonusTone = 'negative'
    }
    else if (record.bonusUsd > 0) {
      details.bonus = `+${formatActivityUsd(record.bonusUsd)}`
      details.bonusTone = 'positive'
    }
    else {
      details.bonus = formatActivityUsd(0)
    }
    details.bonusTitle = 'Collateral seized minus debt repaid, valued in event-time USD'
  }
  else if (
    record.unitOfAccountValuation
    && record.unitOfAccountValuation.unitOfAccountDecimals !== null
  ) {
    const valuation = record.unitOfAccountValuation
    const denomination = getSpecialAddressLabel(valuation.unitOfAccount)
      ?? getTokenMetadata?.(valuation.unitOfAccount)?.symbol
      ?? getAddressLabel?.(valuation.unitOfAccount)
    if (denomination) {
      const fallback = formatActivitySignedUnitValue(
        valuation.bonusValue,
        valuation.unitOfAccountDecimals,
        denomination,
      )
      if (fallback) {
        Object.assign(details, fallback)
        details.bonusTitle = 'Collateral seized minus debt repaid, quoted by the protocol oracle at the liquidation'
      }
    }
  }
  return details
}

const ASSET_KIND_LABELS: Record<ActivityAssetKind, string> = {
  assets: 'Assets',
  shares: 'Shares',
  value: 'Value',
  collateral: 'Collateral',
  yield: 'Yield',
}

export const getActivityAssetLabel = (
  kind: ActivityAssetKind,
  category: ActivityCategory,
  eventType?: ActivityEvent['type'],
): string => {
  if (eventType === 'approval') return 'Allowance'
  if (category === 'liquidations' && kind === 'assets') return 'Debt repaid'
  if (category === 'liquidations' && (kind === 'collateral' || kind === 'yield')) {
    return 'Collateral shares seized'
  }
  return ASSET_KIND_LABELS[kind]
}

export const getActivityAssetAddressLabel = (
  kind: ActivityAssetKind,
  category: ActivityCategory,
): string => {
  if (category === 'liquidations' && (kind === 'collateral' || kind === 'yield')) {
    return 'Collateral vault'
  }
  return 'Asset'
}

export const formatActivityChangeValue = (value: ActivityChangeValue): string => {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'None'
  return String(value)
}

export type ActivityAddressLinkKind = 'explorer' | 'spy' | 'vault'

export interface ActivityChangeAddress {
  address: Address
  label?: string
  linkKind: Exclude<ActivityAddressLinkKind, 'spy'>
  vaultType?: ActivityVaultType
}

export interface ActivityChangeEntry {
  field: string
  label: string
  value?: string
  addresses?: ActivityChangeAddress[]
}

type ActivityChangeEventSource = Pick<ActivityEvent, 'change' | 'type' | 'vault' | 'vaultType'>

const VAULT_ADDRESS_FIELDS_BY_EVENT: Partial<Record<ActivityEvent['type'], readonly string[]>> = {
  liquidation: ['collateral'],
  public_reallocate_to: ['market', 'strategy', 'to', 'vault'],
  public_withdrawal: ['market', 'strategy', 'from', 'vault'],
  reallocate_supply: ['market', 'strategy', 'to', 'vault'],
  reallocate_withdraw: ['market', 'strategy', 'from', 'vault'],
  revoke_pending_cap: ['market', 'strategy', 'vault'],
  revoke_pending_market_removal: ['market', 'strategy', 'vault'],
  set_cap: ['market', 'strategy', 'vault'],
  set_flow_caps: ['market', 'strategy', 'from', 'to', 'vault'],
  set_ltv: ['collateral'],
  set_supply_queue: ['queue', 'supply_queue', 'new_supply_queue'],
  set_withdraw_queue: ['queue', 'withdraw_queue', 'new_withdraw_queue'],
  submit_cap: ['market', 'strategy', 'vault'],
  submit_market_removal: ['market', 'strategy', 'vault'],
}

const parseActivityInteger = (value: ActivityChangeValue): bigint | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  try {
    return BigInt(value)
  }
  catch {
    return null
  }
}

/** Decodes the EVK AmountCap uint16 encoding into underlying token units. */
export const decodeEvkAmountCap = (value: ActivityChangeValue): bigint | null => {
  const raw = parseActivityInteger(value)
  if (raw === null || raw < 0n || raw > 65_535n) return null
  if (raw === 0n) return 0n
  const exponent = raw & 0x3fn
  const mantissa = raw >> 6n
  return (mantissa * 10n ** exponent) / 100n
}

const formatActivityCap = (
  value: ActivityChangeValue,
  vault: Address | undefined,
  getVaultMetadata: ActivityVaultMetadataLookup | undefined,
): string | null => {
  const decoded = decodeEvkAmountCap(value)
  const asset = vault && getVaultMetadata?.(vault)?.asset
  if (decoded === null || !asset) return null
  const amount = formatSmartAmount(formatUnits(decoded, asset.decimals))
  return `${amount} ${asset.symbol}`
}

const formatActivityTokenAmount = (
  value: ActivityChangeValue,
  token: ActivityTokenMetadata | undefined,
): string | null => {
  const amount = parseActivityInteger(value)
  if (amount === null || !token) return null
  return `${formatSmartAmount(formatUnits(amount, token.decimals))} ${token.symbol}`
}

const formatActivityBps = (value: ActivityChangeValue): string | null => {
  const bps = parseActivityInteger(value)
  if (bps === null) return null
  const whole = bps / 100n
  const fraction = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${whole}${fraction ? `.${fraction}` : ''}%`
}

const formatActivityDuration = (value: ActivityChangeValue): string | null => {
  const seconds = parseActivityInteger(value)
  if (seconds === null || seconds < 0n) return null
  if (seconds === 0n) return 'Immediately'
  const units = [
    { label: 'day', seconds: 86_400n },
    { label: 'hour', seconds: 3_600n },
    { label: 'minute', seconds: 60n },
    { label: 'second', seconds: 1n },
  ]
  let remaining = seconds
  const parts: string[] = []
  for (const unit of units) {
    const count = remaining / unit.seconds
    if (count === 0n) continue
    parts.push(`${count} ${unit.label}${count === 1n ? '' : 's'}`)
    remaining %= unit.seconds
    if (parts.length === 2) break
  }
  return parts.join(' ')
}

const formatActivityUnixTimestamp = (value: ActivityChangeValue): string | null => {
  const seconds = parseActivityInteger(value)
  if (seconds === null || seconds < 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const date = new Date(Number(seconds) * 1_000)
  if (!Number.isFinite(date.getTime())) return null
  return formatActivityTimestamp(date.toISOString())
}

const formatActivityChangeLabel = (field: string): string =>
  applyActivityAcronyms(titleizeActivityType(field))

/** Decodes the EVK configFlags bitmask — CFG_DONT_SOCIALIZE_DEBT is the only
 *  publicly-defined bit today. Unknown bit combinations fall back to raw. */
const formatActivityConfigFlags = (value: ActivityChangeValue): string | null => {
  const mask = parseActivityInteger(value)
  if (mask === 0n) return 'Debt socialization enabled'
  if (mask === CFG_DONT_SOCIALIZE_DEBT) return 'Debt socialization disabled'
  return null
}

const formatActivityHookedOperations = (value: ActivityChangeValue): string | null => {
  const mask = parseActivityInteger(value)
  if (mask === null || mask < 0n) return null
  if (mask === 0n) return 'None'

  const { hookedOperations, unknownMask } = decodeHookedOperationsMask(mask)
  const names = getHookedOperationMetas(hookedOperations, { includeInternal: true })
    .map(operation => operation.name)
  if (unknownMask !== 0n) names.push(`Unknown flags (${unknownMask})`)
  return names.join(', ')
}

const isZeroAddressValue = (value: ActivityChangeValue): boolean => {
  const values = Array.isArray(value) ? value : [value]
  return values.length > 0 && values.every(item =>
    typeof item === 'string' && item.toLowerCase() === zeroAddress,
  )
}

/** Display order for change fields whose upstream order is unhelpful. */
const CHANGE_FIELD_PRIORITY: Partial<Record<ActivityEvent['type'], readonly string[]>> = {
  set_ltv: [
    'collateral',
    'borrow_ltv',
    'liquidation_ltv',
    'ramp_duration',
    'initial_liquidation_ltv',
    'target_timestamp',
  ],
}

const REALLOCATION_EVENT_TYPES: readonly ActivityEvent['type'][] = [
  'reallocate_supply',
  'reallocate_withdraw',
  'public_reallocate_to',
  'public_withdrawal',
]

const orderedActivityChangeFields = (
  event: ActivityChangeEventSource,
): [string, ActivityChangeValue][] => {
  let fields = Object.entries(event.change?.fields ?? {})

  // An immediate LTV change never ramps — the ramp target fields are noise.
  if (
    event.type === 'set_ltv'
    && parseActivityInteger(event.change?.fields.ramp_duration ?? null) === 0n
  ) {
    fields = fields.filter(([field]) =>
      field !== 'initial_liquidation_ltv' && field !== 'target_timestamp',
    )
  }

  // Reallocations report the same movement in underlying assets and in
  // strategy shares — the share amount is redundant next to the asset amount.
  if (REALLOCATION_EVENT_TYPES.includes(event.type)) {
    fields = fields.filter(([field]) => field !== 'shares' && !field.endsWith('_shares'))
  }

  const priority = CHANGE_FIELD_PRIORITY[event.type]
  if (!priority) return fields
  const rank = (field: string) => {
    const index = priority.indexOf(field)
    return index === -1 ? priority.length : index
  }
  return fields.sort((left, right) => rank(left[0]) - rank(right[0]))
}

const resolveChangeAddresses = (
  event: ActivityChangeEventSource,
  field: string,
  value: ActivityChangeValue,
  getVaultMetadata: ActivityVaultMetadataLookup | undefined,
): ActivityChangeAddress[] | null => {
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || !values.every(item => typeof item === 'string' && isAddress(item))) return null

  const isVaultAddress = VAULT_ADDRESS_FIELDS_BY_EVENT[event.type]?.includes(field) ?? false
  return values.map((item) => {
    const address = item as Address
    if (!isVaultAddress) return { address, linkKind: 'explorer' as const }
    const display = getVaultMetadata
      ? resolveActivityVaultDisplay(address, getVaultMetadata)
      : null
    return {
      address,
      linkKind: 'vault' as const,
      label: display?.name ?? display?.addressLabel,
      vaultType: getVaultMetadata?.(address)?.vaultType ?? event.vaultType,
    }
  })
}

export const getActivityChangeEntries = (
  event: ActivityChangeEventSource,
  getVaultMetadata?: ActivityVaultMetadataLookup,
): ActivityChangeEntry[] => orderedActivityChangeFields(event).map(([field, value]) => {
  // The zero address reads better as an explicit "None" than as a linked,
  // copyable 0x0000…0000 (e.g. a renounced governor or cleared receiver).
  if (isZeroAddressValue(value)) {
    return { field, label: formatActivityChangeLabel(field), value: 'None' }
  }
  const addresses = resolveChangeAddresses(event, field, value, getVaultMetadata)
  if (addresses) return { field, label: formatActivityChangeLabel(field), addresses }

  let formatted: string | null = null
  const vaultMetadata = event.vault ? getVaultMetadata?.(event.vault) : undefined
  if (event.type === 'set_caps' && (field === 'supply_cap' || field === 'borrow_cap')) {
    formatted = formatActivityCap(value, event.vault, getVaultMetadata)
  }
  else if (
    (event.type === 'set_cap' || event.type === 'submit_cap')
    && field === 'cap'
  ) {
    formatted = formatActivityTokenAmount(value, vaultMetadata?.asset)
  }
  else if (
    event.type === 'set_supply_cap'
    && (field === 'cap' || field === 'supply_cap' || field === 'new_supply_cap')
  ) {
    formatted = formatActivityTokenAmount(value, vaultMetadata?.asset)
  }
  else if (
    (event.type === 'reallocate_supply' || event.type === 'reallocate_withdraw')
    && (field === 'supplied_assets' || field === 'withdrawn_assets')
  ) {
    formatted = formatActivityTokenAmount(value, vaultMetadata?.asset)
  }
  else if (event.type === 'set_ltv' && field.endsWith('_ltv')) {
    formatted = formatActivityBps(value)
  }
  else if (
    event.type === 'set_config_flags'
    && (field === 'config_flags' || field === 'new_config_flags')
  ) {
    formatted = formatActivityConfigFlags(value)
  }
  // EVK ConfigAmounts are scaled over 1e4 — 500 reads as 5%, 350 as 3.5%.
  else if (
    event.type === 'set_interest_fee'
    && ['fee', 'new_fee', 'interest_fee', 'new_interest_fee'].includes(field)
  ) {
    formatted = formatActivityBps(value)
  }
  else if (
    event.type === 'set_max_liquidation_discount'
    && ['discount', 'new_discount', 'max_liquidation_discount', 'new_max_liquidation_discount'].includes(field)
  ) {
    formatted = formatActivityBps(value)
  }
  else if (
    event.type === 'set_hook_config'
    && (field === 'hooked_ops' || field === 'new_hooked_ops')
  ) {
    formatted = formatActivityHookedOperations(value)
  }
  else if (field === 'target_timestamp') {
    formatted = formatActivityUnixTimestamp(value)
  }
  else if (field === 'ramp_duration' || field.endsWith('_timelock') || field.endsWith('_cool_off_time')) {
    formatted = formatActivityDuration(value)
  }

  return {
    field,
    label: formatActivityChangeLabel(field),
    value: formatted ?? formatActivityChangeValue(value),
  }
})

interface ActivityParticipantSource {
  account?: Address
  actor?: Address
  category: ActivityCategory
  counterparty?: Address
  owner?: Address
  subAccountIndex?: number
  type?: ActivityEvent['type']
}

export interface PortfolioActivityPositionParticipant {
  index: number
  label: string
}

export const getPortfolioActivityPositionParticipant = (
  event: ActivityParticipantSource,
): PortfolioActivityPositionParticipant | null => {
  if (
    event.category !== 'liquidations'
    || event.subAccountIndex === undefined
    || !event.account
    || !event.counterparty
    || event.account.toLowerCase() !== event.counterparty.toLowerCase()
  ) return null

  return {
    index: event.subAccountIndex,
    label: `Position ${event.subAccountIndex}`,
  }
}

/**
 * Vault registry lookups worth attempting for an event: the event's vault,
 * share/collateral asset addresses, and vault-typed change fields. Resolving
 * these turns raw addresses into named vault links.
 */
export const getActivityResolvableVaultAddresses = (
  event: Pick<ActivityEvent, 'vault' | 'type' | 'assets' | 'change'>,
): Address[] => {
  const addresses = new Set<Address>()
  if (event.vault) addresses.add(event.vault)
  for (const asset of event.assets ?? []) {
    if (asset.address && ['collateral', 'shares', 'yield'].includes(asset.kind)) {
      addresses.add(asset.address)
    }
  }
  for (const field of VAULT_ADDRESS_FIELDS_BY_EVENT[event.type] ?? []) {
    const value = event.change?.fields[field]
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && isAddress(item)) addresses.add(item as Address)
    }
  }
  return [...addresses]
}

export const formatActivityValuation = (
  valuation: ActivityValuation | undefined,
): string | null => {
  if (!valuation) return null
  if (valuation.status === 'unavailable') return null
  if (valuation.amountUsd === undefined) {
    return valuation.status === 'partial' ? 'Partial USD valuation' : null
  }
  const amount = formatActivityUsd(valuation.amountUsd)
  return valuation.status === 'partial' ? `${amount} (partial)` : amount
}

export const formatActivityValuationForAssets = (
  valuation: ActivityValuation | undefined,
  assets: readonly ActivityAssetAmount[],
): string | null => {
  if (
    valuation?.status === 'available'
    && assets.some(asset => asset.amountUsd !== undefined)
  ) return null
  return formatActivityValuation(valuation)
}
