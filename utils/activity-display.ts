import type {
  ActivityAssetAmount,
  ActivityAssetKind,
  ActivityCategory,
  ActivityChange,
  ActivityChangeValue,
  ActivityCoverageStatus,
  ActivityEvent,
  ActivityValuation,
  ActivityVaultType,
} from '@eulerxyz/euler-v2-sdk'
import { formatUnits, type Address } from 'viem'
import { formatCompactUsdValue, formatSmartAmount } from '~/utils/string-utils'

interface ActivityTokenMetadata {
  address: Address
  symbol: string
  decimals: number
}

interface ActivityVaultMetadata {
  asset?: ActivityTokenMetadata
  shares?: ActivityTokenMetadata
}

interface ActivityAssetContext {
  category: ActivityCategory
  vault?: Address
}

type ActivityVaultMetadataLookup = (address: Address) => ActivityVaultMetadata | undefined
type ActivityTokenMetadataLookup = (address: Address) => ActivityTokenMetadata | undefined

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  lending: 'Lending',
  borrowing: 'Borrowing',
  swaps: 'Swaps',
  liquidations: 'Liquidations',
  account: 'Account',
  rewards: 'Rewards',
  governance: 'Governance',
}

const ACCOUNT_ACTIVITY_EVENT_TYPES = [
  'deposit',
  'withdraw',
  'transfer',
  'borrow',
  'repay',
  'swap',
  'debt_socialized',
  'pull_debt',
  'liquidation',
  'approval',
  'balance_forwarder_status',
  'convert_fees',
  'reallocate_supply',
  'reallocate_withdraw',
  'set_fee',
  'set_guardian',
  'set_timelock',
  'set_cap',
  'set_supply_queue',
  'set_withdraw_queue',
  'submit_cap',
  'submit_market_removal',
  'revoke_pending_cap',
  'revoke_pending_guardian',
  'revoke_pending_timelock',
  'revoke_pending_market_removal',
  'frozen',
  'unfrozen',
  'seized',
  'owner_registered',
  'collateral_status',
  'operator_status',
  'controller_status',
  'lockdown_mode_status',
  'nonce_status',
  'nonce_used',
  'permit_disabled_mode_status',
  'reward_lock_created',
  'reward_lock_removed',
  'reward_transfer',
  'reward_whitelist_status',
  'public_reallocate_to',
  'public_withdrawal',
  'set_admin',
  'set_allocation_fee',
  'set_flow_caps',
  'transfer_allocation_fee',
  'buy',
  'terms_of_use_signed',
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
    'update_last_total_assets',
    'update_lost_assets',
    'approval',
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
): ActivityEvent[] => {
  const displayEventTypes = new Set<string>(eventTypes)
  const visibleEvents = events.filter(event => displayEventTypes.has(event.type))
  const pairedTypes = new Set<ActivityEvent['type']>([
    'deposit',
    'withdraw',
    'liquidation',
    'reallocate_supply',
    'reallocate_withdraw',
    'public_reallocate_to',
    'public_withdrawal',
  ])

  return visibleEvents.filter((event) => {
    if (event.type !== 'transfer' || !event.groupId) return true

    const shareMovements = event.assets?.filter(asset => asset.kind === 'shares') ?? []
    if (shareMovements.length === 0) return true

    return !events.some((candidate) => {
      if (
        candidate.id === event.id
        || candidate.groupId !== event.groupId
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

export interface ActivityFilterOption {
  value: string
  label: string
  categories: readonly ActivityCategory[]
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
    if (direction === 'sent') return 'Sent shares'
    if (direction === 'received') return 'Received shares'
    return 'Shares transferred'
  }
  return titleizeActivityType(event.type)
}

export interface ActivityEventIcon {
  name: string
}

export const getActivityEventIcon = (
  event: Pick<ActivityEventLabelSource, 'account' | 'payload' | 'type'> & { category: ActivityCategory },
): ActivityEventIcon => {
  if (event.type === 'transfer') {
    const direction = getActivityTransferDirection(event)
    if (direction === 'sent') return { name: 'borrow-outline' }
    if (direction === 'received') return { name: 'lend-outline' }
    return { name: 'swap-horizontal' }
  }
  if (['withdraw', 'borrow', 'reallocate_withdraw', 'public_withdrawal'].includes(event.type)) {
    return { name: 'borrow-outline' }
  }
  if (['deposit', 'repay', 'reallocate_supply', 'public_reallocate_to'].includes(event.type)) {
    return { name: 'lend-outline' }
  }
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
  }).format(date)
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

export const formatActivityAssetAmount = (asset: ActivityAssetAmount): string => {
  const amount = resolveAssetAmount(asset)
  if (amount === undefined) return 'Amount unavailable'
  const formatted = formatSmartAmount(amount)
  return asset.symbol ? `${formatted} ${asset.symbol}` : formatted
}

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

export const formatActivityAssetUsd = (asset: ActivityAssetAmount): string | null =>
  asset.amountUsd === undefined
    ? null
    : formatCompactUsdValue(asset.amountUsd)

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
): string => {
  if (category === 'liquidations' && kind === 'assets') return 'Debt repaid'
  if (category === 'liquidations' && (kind === 'collateral' || kind === 'yield')) {
    return 'Collateral seized'
  }
  return ASSET_KIND_LABELS[kind]
}

export const getActivityAssetAddressLabel = (
  kind: ActivityAssetKind,
  category: ActivityCategory,
): string => {
  if (category === 'liquidations' && kind === 'assets') return 'Debt vault'
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

export interface ActivityChangeEntry {
  field: string
  label: string
  value: string
}

export const getActivityChangeEntries = (
  change: ActivityChange | undefined,
): ActivityChangeEntry[] => Object.entries(change?.fields ?? {}).map(([field, value]) => ({
  field,
  label: titleizeActivityType(field),
  value: formatActivityChangeValue(value),
}))

export interface ActivityParticipant {
  address: Address
  label: string
}

interface ActivityParticipantSource {
  account?: Address
  actor?: Address
  category: ActivityCategory
  counterparty?: Address
  owner?: Address
}

export const getActivityParticipants = (
  event: ActivityParticipantSource,
): ActivityParticipant[] => {
  const participants: ActivityParticipant[] = []
  const add = (label: string, address: Address | undefined) => {
    if (
      !address
      || participants.some(participant => participant.address.toLowerCase() === address.toLowerCase())
    ) return
    participants.push({ label, address })
  }

  if (event.category === 'liquidations') {
    add('Liquidator', event.actor)
    add('Violator', event.counterparty)
    return participants
  }

  if (event.category === 'governance') {
    add('Actor', event.actor)
    add('Target', event.counterparty)
    return participants
  }

  const user = event.account ?? event.owner ?? event.actor
  add('User', user)
  add('Actor', event.actor)
  add('Counterparty', event.counterparty)
  return participants
}

export const formatActivityValuation = (
  valuation: ActivityValuation | undefined,
): string | null => {
  if (!valuation) return null
  if (valuation.status === 'unavailable') return null
  if (valuation.amountUsd === undefined) {
    return valuation.status === 'partial' ? 'Partial USD valuation' : null
  }
  const amount = formatCompactUsdValue(valuation.amountUsd)
  return valuation.status === 'partial' ? `${amount} (partial)` : amount
}
