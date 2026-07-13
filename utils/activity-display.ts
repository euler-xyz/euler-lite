import type {
  ActivityAssetAmount,
  ActivityAssetKind,
  ActivityCategory,
  ActivityChange,
  ActivityChangeValue,
  ActivityCoverageStatus,
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

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  lending: 'Lending',
  borrowing: 'Borrowing',
  swaps: 'Swaps',
  liquidations: 'Liquidations',
  account: 'Account',
  rewards: 'Rewards',
  governance: 'Governance',
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
  { borrowable = true }: { borrowable?: boolean } = {},
): ActivityFilterOption[] => {
  const userCategories: ActivityCategory[] = vaultType === 'evk' && borrowable
    ? ['lending', 'borrowing']
    : ['lending']
  const options: ActivityFilterOption[] = [
    { value: 'user-operations', label: 'User operations', categories: userCategories },
    { value: 'governance', label: 'Governance', categories: ['governance'] },
  ]
  if (vaultType === 'evk' && borrowable) {
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

export const formatActivityEventLabel = (
  event: { label?: string, type: string },
): string => event.label?.trim() || titleizeActivityType(event.type)

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
  if (amount === undefined) {
    try {
      return `Raw: ${BigInt(asset.amountRaw).toLocaleString('en-US')}`
    }
    catch {
      return 'Amount unavailable'
    }
  }
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
  if (valuation.status === 'unavailable') return 'USD value unavailable'
  if (valuation.amountUsd === undefined) {
    return valuation.status === 'partial' ? 'Partial USD valuation' : null
  }
  const amount = formatCompactUsdValue(valuation.amountUsd)
  return valuation.status === 'partial' ? `${amount} (partial)` : amount
}
