import type { EulerLabelEntity } from '~/entities/euler/labels'
import type { AnyVault } from '~/composables/useVaultRegistry'

// -- Market Grouping (Hybrid Algorithm) --

export interface MarketGroup {
  /** Product name or generated hash for orphan groups */
  id: string
  /** Human-readable name: "RE7 ETH Market" or "Ungrouped #1" */
  name: string
  /** How the group was derived */
  source: 'product' | 'algorithmic'
  /** Curator entity (null for algorithmic groups) */
  curator?: EulerLabelEntity
  /** Curator entity key from labels */
  curatorKey?: string
  /** Core member vaults */
  vaults: AnyVault[]
  /** Vaults referenced as collateral but not in this group */
  externalCollateral: AnyVault[]
  /**
   * Lowercased addresses of external collateral references the discovery view
   * should flag with a red indicator. Two cases qualify:
   *  1. The vault is in the registry but its governor isn't part of any
   *     declared product entity — same signal as the per-pair "Unknown"
   *     risk-manager pill (see `useVaults.isVaultGovernorVerified`).
   *  2. The vault isn't loaded into the registry at all (truly missing).
   * Group-member vaults are never included — the curator's product label
   * is an explicit attestation that those are theirs.
   */
  unknownCollateral: string[]
  metrics: MarketGroupMetrics
}

export interface MarketGroupMetrics {
  /** Sum of priced vault TVLs in USD (skips unpriced vaults) */
  totalTVL: number
  /** Whether all vaults in the group have USD pricing */
  allVaultsPriced: boolean
  /** How many vaults have USD pricing */
  pricedVaultCount: number
  /** Sum of (supply - borrow) in USD for borrowable vaults */
  totalAvailableLiquidity: number
  /** Sum of borrowed amounts in USD for borrowable vaults */
  totalBorrowed: number
  /** Best supply APY across all vaults, as a percentage value. */
  bestSupplyAPY: number
  /** Best (lowest) borrow APY across borrowable vaults */
  bestBorrowAPY: number
  /** Total number of vaults */
  vaultCount: number
  /** Vaults with utilization (non-escrow) */
  borrowableVaultCount: number
  /** Average utilization of borrowable vaults (0-100) */
  averageUtilization: number
  /** Unique asset symbols in this market */
  assetSymbols: string[]
  /** Whether the group contains any recently added vaults */
  hasRecentlyAdded: boolean
}

// -- Curator Grouping (for Heatmap/Treemap views) --

export interface CuratorGroup {
  key: string
  name: string
  logo?: string
  markets: MarketGroup[]
  /** Sum of all market TVLs (skips unpriced vaults) */
  totalTVL: number
  /** Whether all markets have full pricing */
  allVaultsPriced: boolean
  pricedMarketCount: number
  vaultCount: number
}

// -- Mini Diagram Types (for market structure visualization) --

export interface MiniNode {
  address: string
  assetAddress: string
  assetSymbol: string
  x: number
  y: number
  /** False for address-only placeholder nodes that have no loaded vault data. */
  hasVaultData?: boolean
  /**
   * True when the node should render the red "unknown" badge. Applies to
   * external collaterals with an unverified governor (resolved vault, badge
   * sits beside the asset logo) and to placeholder nodes for truly missing
   * vaults (no vault data — they fall back to the standard logo-less node
   * with the truncated vault address as their label).
   */
  isUnknown?: boolean
}

export interface MiniEdge {
  from: MiniNode
  to: MiniNode
  mutual: boolean
}

export interface MiniDiagramData {
  nodes: MiniNode[]
  edges: MiniEdge[]
  pairCount: number
  assetCount: number
  viewWidth: number
}
