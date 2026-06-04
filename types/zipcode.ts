// Zip Code Finance — lender demo data model, fixtures and formatters.
//
// This file is the single source of truth for the demo's mocked types and seed
// values. It is intentionally framework-agnostic (no Vue imports) so it can be
// reused by composables, components and future contract-backed adapters. The
// reactive store lives in `composables/zipcode/useZipDemo.ts`, which seeds its
// state from `initialDemoState` and reads protocol/funding fixtures from here.
//
// Spec: ~/Downloads/zip-code-finance-lender-demo-spec-v3.md (sections 12–13, 17).

export type FeatureFlags = {
  showInstitutionalTeaser: boolean
  showFastExit: boolean
  showAdvancedSettings: boolean
  showWalletOption: boolean
  showProtocolHealthPage: boolean
  // Future extension hook — szipUSD staking is intentionally not built (spec §6.2, §20).
  showSzipUsd: boolean
}

export type ProtocolHealth = {
  totalNavUsd: number
  zipUsdMinted: number
  zipUsdMarketPriceUsd: number
  availableLiquidityUsd: number
  capitalDeployedUsd: number
  redemptionQueueUsd: number
  idleUsdcReserveUsd: number
}

export type LenderPosition = {
  totalDepositedUsd: number
  portfolioValueUsd: number
  zipUsdBalance: number
  digitalDollarBalanceUsd: number
}

export type FundingSource = {
  id: string
  type: 'digital-dollar' | 'wallet'
  label: string
  detail: string
  balanceUsd: number
  isPrimary?: boolean
}

export type RedemptionStatus
  = | 'queued'
    | 'partially-settled'
    | 'claimable'
    | 'claimed'

export type RedemptionRequest = {
  id: string
  zipUsdRequested: number
  usdcClaimable: number
  zipUsdCarriedForward: number
  epochStart: string
  epochEnd: string
  status: RedemptionStatus
}

export type ActivityType
  = | 'deposit-usdc'
    | 'mint-zipusd'
    | 'redemption-request'
    | 'redemption-settlement'
    | 'claim-usdc'
    | 'fast-exit'

export type ActivityItem = {
  id: string
  createdAt: string
  type: ActivityType
  label: string
  amountUsd?: number
  amountUsdc?: number
  amountZipUsd?: number
  status?: 'pending' | 'complete'
}

export type ActivityFilter = 'all' | 'deposits' | 'redemptions' | 'claims'

export type DemoState = {
  kybStatus: 'not-started' | 'approved'
  position: LenderPosition
  redemptionRequests: RedemptionRequest[]
  activity: ActivityItem[]
  lastDepositZipUsd: number
  claimSuccessUsdc: number
}

// Read surface consumed by pages/components. The default implementation is the
// mocked store; a future on-chain adapter can implement the same interface so
// page-level code never changes (spec §12, plan "adapter" note).
export type ZipDemoReader = {
  getProtocolHealth: () => ProtocolHealth
  getPosition: () => LenderPosition
  getActiveRedemptionRequest: () => RedemptionRequest
  getActivity: () => ActivityItem[]
  getFundingSources: () => FundingSource[]
}

export const featureFlags: FeatureFlags = {
  showInstitutionalTeaser: true,
  showFastExit: true,
  showAdvancedSettings: true,
  showWalletOption: true,
  showProtocolHealthPage: true,
  showSzipUsd: false,
}

export const demoConfig = {
  lenderName: 'Lisa Morgan',
  lenderEmail: 'lisa@example.com',
  institutionName: 'Morgan Capital Partners',
  defaultDepositUsd: 100_000,
  defaultRedemptionZipUsd: 5_000,
  partialClaimableUsdc: 3_500,
  partialCarriedForwardZipUsd: 1_500,
  epochStart: '2026-06-01',
  epochEnd: '2026-06-30',
  secondaryMarketPriceUsd: 0.994,
  depositProcessingDelayMs: 850,
  network: 'Base',
  walletAddress: '0x12…89AF',
} as const

export const protocolHealth: ProtocolHealth = {
  totalNavUsd: 15_000_000,
  zipUsdMinted: 12_800_000,
  zipUsdMarketPriceUsd: 1,
  availableLiquidityUsd: 3_200_000,
  capitalDeployedUsd: 11_800_000,
  redemptionQueueUsd: 420_000,
  idleUsdcReserveUsd: 3_200_000,
}

export const fundingSources: FundingSource[] = [
  {
    id: 'digital-dollar',
    type: 'digital-dollar',
    label: 'Digital-dollar balance',
    detail: '250,000 USDC available',
    balanceUsd: 250_000,
    isPrimary: true,
  },
  {
    id: 'wallet',
    type: 'wallet',
    label: 'Connected wallet',
    detail: 'Advanced option',
    balanceUsd: 250_000,
  },
]

export const initialDemoState: DemoState = {
  kybStatus: 'not-started',
  position: {
    totalDepositedUsd: 0,
    portfolioValueUsd: 0,
    zipUsdBalance: 0,
    digitalDollarBalanceUsd: 250_000,
  },
  redemptionRequests: [],
  activity: [],
  lastDepositZipUsd: 0,
  claimSuccessUsdc: 0,
}

// Fallback request used when none has been created yet, so status views can
// render a representative "queued" example during a demo walkthrough.
export const fallbackRedemptionRequest: RedemptionRequest = {
  id: 'redeem-001',
  zipUsdRequested: demoConfig.defaultRedemptionZipUsd,
  usdcClaimable: 0,
  zipUsdCarriedForward: 0,
  epochStart: demoConfig.epochStart,
  epochEnd: demoConfig.epochEnd,
  status: 'queued',
}

export const navToZipUsdMintedRatio
  = protocolHealth.totalNavUsd / protocolHealth.zipUsdMinted

// --- Formatters -------------------------------------------------------------
// Dollar-first display per spec §5.2: primary values render with no cents,
// asset units carry an explicit suffix. These are demo-local because euler's
// `formatUsdValue` defaults to 2 fraction digits and has no token-unit suffix.

export const formatCurrency = (
  value: number,
  options?: { compact?: boolean, cents?: boolean },
): string => {
  if (options?.compact) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: options?.cents ? 2 : 0,
  }).format(value)
}

export const formatAsset = (value: number, asset: 'USDC' | 'zipUSD'): string =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} ${asset}`

export const formatZipUsd = (value: number): string => formatAsset(value, 'zipUSD')

export const formatUsdc = (value: number): string => formatAsset(value, 'USDC')

export const formatDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  })

export const formatEpochRange = (startIso: string, endIso: string): string => {
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }
  const start = new Date(`${startIso}T00:00:00Z`).toLocaleDateString('en-US', opts)
  const end = new Date(`${endIso}T00:00:00Z`).toLocaleDateString('en-US', opts)
  return `${start} – ${end}`
}
