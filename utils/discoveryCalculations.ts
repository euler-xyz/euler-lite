import { isEVault, isSecuritizeCollateralVault, type SecuritizeCollateralVault, type EVaultCollateral, type EVault } from '@eulerxyz/euler-v2-sdk'
import type { MarketGroup, MiniDiagramData, MiniNode, MiniEdge } from '~/entities/lend-discovery'
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { isLiveCollateralEdge } from '~/utils/vault/ltv'
import { maxUint256 } from 'viem'
import type { AnyVault } from '~/composables/useVaultRegistry'

import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getEntitiesByVault, isVaultCyclicalNote, isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { formatNumber, compactNumber, truncate } from '~/utils/string-utils'
import { formatHookedOpsSummary, getHookedOperationMetas, getVaultHookedOperations, hasAnyHookedOperation, isVaultEffectivelyPaused } from '~/utils/vault-hooks'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { getVaultBorrowApy, getVaultSupplyApy } from '~/utils/vault-display'
import { computeSupplyApy, computeBorrowApy, type ApyVisibilitySettings } from '~/utils/collateralOptions'
import { getMaxLiquidationDiscountDisplayPercent } from '~/utils/vault/liquidation'

// ============================================================
// Types & Constants
// ============================================================

export interface MatrixCell {
  ltv: EVaultCollateral
}

export interface CollateralMatrixData {
  rows: Array<{ address: string, symbol: string, assetAddress: string, category: 'escrow' | 'external' | 'borrowable' }>
  columns: Array<{ address: string, symbol: string, assetAddress: string }>
  cells: Map<string, Map<string, MatrixCell>>
  pairCount: number
}

export interface BestMaxRoeResult {
  value: number
  metric: 'max-roe' | 'net-apy'
  hasRewards: boolean
  pair: string
  maxMultiplier: number
  supplyAPY: number
  borrowAPY: number
  borrowLTV: number
  borrowVaultAddress: string
  collateralAddress: string
}

export interface EnhancedCellApys {
  supplyApy: number
  borrowApy: number
  netApy: number
  roe: number
  utilization: number
}

export type DotMetric = 'bltv' | 'lltv' | 'net-apy' | 'roe' | 'multiplier' | 'oracle'

export interface DotMetricOption {
  id: DotMetric
  label: string
  higherIsBetter: boolean
}

export const DOT_METRIC_OPTIONS: DotMetricOption[] = [
  { id: 'net-apy', label: 'Net APY', higherIsBetter: true },
  { id: 'roe', label: 'Max ROE', higherIsBetter: true },
  { id: 'multiplier', label: 'Multiplier', higherIsBetter: false },
  { id: 'bltv', label: 'Borrow LTV', higherIsBetter: false },
  { id: 'lltv', label: 'Liquidation LTV', higherIsBetter: false },
  { id: 'oracle', label: 'Oracles', higherIsBetter: false },
]

export type ExpandedViewMode = 'graph' | 'matrix'

export type MatrixVariant = 'pairs' | 'config' | 'stats' | 'open-interest'
export type AttributeMatrixMode = 'config' | 'stats'
export type OpenInterestMatrixMode = 'open-interest'

// Unified matrix-view selector. Wraps both attribute matrices (stats / config)
// and pair-matrix metric variants (oracle + numeric metrics). Order is the
// order shown in the dropdown.
export type MatrixViewId = AttributeMatrixMode | OpenInterestMatrixMode | DotMetric
export interface MatrixViewOption {
  id: MatrixViewId
  label: string
}
export const MATRIX_VIEW_OPTIONS: MatrixViewOption[] = [
  { id: 'stats', label: 'Stats' },
  { id: 'config', label: 'Configuration' },
  { id: 'open-interest', label: 'Open Interest' },
  { id: 'oracle', label: 'Oracles' },
  { id: 'net-apy', label: 'Net APY' },
  { id: 'roe', label: 'Max ROE' },
  { id: 'multiplier', label: 'Multiplier' },
  { id: 'bltv', label: 'Borrow LTV' },
  { id: 'lltv', label: 'Liquidation LTV' },
]

export const isAttributeMatrixView = (id: MatrixViewId): id is AttributeMatrixMode =>
  id === 'stats' || id === 'config'

// ============================================================
// Vault Type Guards & Accessors
// ============================================================

export const isVaultType = (vault: AnyVault): vault is EVault =>
  isEVault(vault)

const isSecuritizeVault = (v: AnyVault): v is SecuritizeCollateralVault =>
  isSecuritizeCollateralVault(v)

export const getVaultAddress = (vault: AnyVault): string =>
  isEVault(vault) ? vault.address : ('address' in vault ? (vault as { address: string }).address : '')

export const getVaultAssetSymbol = (vault: AnyVault): string => {
  if (isEVault(vault)) return vault.asset.symbol
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object') {
    const asset = vault.asset as unknown as Record<string, unknown>
    if ('symbol' in asset && typeof asset.symbol === 'string') return asset.symbol
  }
  return '?'
}

export const getVaultAssetAddress = (vault: AnyVault): string => {
  if (isEVault(vault)) return vault.asset.address
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object') {
    const asset = vault.asset as unknown as Record<string, unknown>
    if ('address' in asset && typeof asset.address === 'string') return asset.address
  }
  return ''
}

// ============================================================
// Market Data Helpers
// ============================================================

// Count members and externals so the headline matches the per-node badge in
// the graph (which paints any deprecated address regardless of role). Dedupe
// in case the same address appears in both lists.
export const getDeprecatedVaultCount = (market: MarketGroup): number => {
  const seen = new Set<string>()
  let count = 0
  for (const v of [...market.vaults, ...market.externalCollateral]) {
    const addr = getVaultAddress(v).toLowerCase()
    if (!addr || seen.has(addr)) continue
    seen.add(addr)
    if (isVaultDeprecated(addr)) count++
  }
  return count
}

export const getUnknownCollateralCount = (market: MarketGroup): number =>
  market.unknownCollateral.length

export const getMarketEntities = (market: MarketGroup): { name: string, logos: string[] } => {
  const seen = new Set<string>()
  const all: EulerLabelEntity[] = []
  for (const v of market.vaults) {
    for (const entity of getEntitiesByVault(v)) {
      if (seen.has(entity.name)) continue
      seen.add(entity.name)
      all.push(entity)
    }
  }
  if (all.length === 0) return { name: '', logos: [] }
  const name = all.length === 1
    ? all[0].name
    : all.length === 2
      ? `${all[0].name} & ${all[1].name}`
      : `${all[0].name} & others`
  return { name, logos: all.map(e => getEulerLabelEntityLogo(e.logo)) }
}

const hasBorrowableLTV = (vault: EVault): boolean =>
  vault.collaterals.some(ltv => ltv.borrowLTV > 0)

export const getBorrowableVaults = (market: MarketGroup): EVault[] =>
  market.vaults.filter(isEVault).filter(hasBorrowableLTV)

export const getNonBorrowableMemberVaults = (market: MarketGroup): EVault[] =>
  market.vaults.filter(isEVault).filter(v => !hasBorrowableLTV(v))

const hasLiveDiscoveryColumn = (vault: EVault): boolean =>
  vault.collaterals.some(ltv => isLiveCollateralEdge(ltv))

const getDiscoveryColumnVaults = (market: MarketGroup): EVault[] =>
  market.vaults.filter(isEVault).filter(hasLiveDiscoveryColumn)

const getDiscoveryRowOnlyVaults = (market: MarketGroup): EVault[] =>
  market.vaults.filter(isEVault).filter(v => !hasLiveDiscoveryColumn(v))

export const isExternalCollateral = (market: MarketGroup, address: string): boolean => {
  const normalized = address.toLowerCase()
  return market.externalCollateral.some(v => getVaultAddress(v).toLowerCase() === normalized)
}

export const getActiveExternalCollateral = (market: MarketGroup): AnyVault[] => {
  const columnVaults = getDiscoveryColumnVaults(market)
  return market.externalCollateral.filter((ext) => {
    const extAddr = getVaultAddress(ext).toLowerCase()
    return columnVaults.some(v =>
      v.collaterals.some(ltv =>
        ltv.address.toLowerCase() === extAddr && isLiveCollateralEdge(ltv),
      ),
    )
  })
}

export const findVault = (market: MarketGroup, address: string): EVault | SecuritizeCollateralVault | null => {
  const normalized = address.toLowerCase()
  for (const v of market.vaults) {
    if (getVaultAddress(v).toLowerCase() === normalized) return v as EVault | SecuritizeCollateralVault
  }
  for (const v of market.externalCollateral) {
    if (getVaultAddress(v).toLowerCase() === normalized) return v as EVault | SecuritizeCollateralVault
  }
  return null
}

// ============================================================
// Mini Relationship Graph
// ============================================================

export const getMiniDiagram = (market: MarketGroup): MiniDiagramData => {
  const vaultByAddr = new Map<string, AnyVault>()
  for (const v of [...market.vaults, ...market.externalCollateral]) {
    const addr = getVaultAddress(v).toLowerCase()
    if (addr) vaultByAddr.set(addr, v)
  }
  const unknownSet = new Set(market.unknownCollateral.map(a => a.toLowerCase()))

  const directedEdges = new Set<string>()
  const displayEdges = new Set<string>()
  const connectedAddresses = new Set<string>()
  const connectedUnknownAddresses = new Set<string>()

  for (const vault of market.vaults) {
    if (!isEVault(vault)) continue
    for (const ltv of vault.collaterals) {
      const colAddr = ltv.address.toLowerCase()
      const isKnown = vaultByAddr.has(colAddr)
      const isUnknownPlaceholder = !isKnown && unknownSet.has(colAddr)
      if (!isKnown && !isUnknownPlaceholder) continue
      const liabAddr = vault.address.toLowerCase()
      // directedEdges drives the borrowable-pair count rendered next to the
      // graph — only currently borrowable edges count, and only against known
      // collateral so the headline isn't inflated by truly missing references
      // (those get their own "X unknown" indicator). displayEdges drives
      // graph rendering and includes mid-ramp edges so a winding-down
      // collateral remains visually connected.
      if (isKnown && ltv.borrowLTV > 0) {
        directedEdges.add(`${colAddr}:${liabAddr}`)
      }
      if (isLiveCollateralEdge(ltv)) {
        displayEdges.add(`${colAddr}:${liabAddr}`)
        connectedAddresses.add(liabAddr)
        if (isKnown) connectedAddresses.add(colAddr)
        else connectedUnknownAddresses.add(colAddr)
      }
    }
  }

  const disconnectedVaults: Array<{ address: string, vault: AnyVault }> = []
  for (const v of market.vaults) {
    const addr = getVaultAddress(v).toLowerCase()
    if (addr && !connectedAddresses.has(addr)) {
      disconnectedVaults.push({ address: addr, vault: v })
    }
  }

  if (connectedAddresses.size === 0 && connectedUnknownAddresses.size === 0 && disconnectedVaults.length === 0) {
    const assetSymbols = new Set<string>()
    for (const v of market.vaults) assetSymbols.add(getVaultAssetSymbol(v))
    return { nodes: [], edges: [], pairCount: 0, assetCount: assetSymbols.size, viewWidth: 0 }
  }

  const allNodeEntries = [
    ...[...connectedAddresses].map(addr => ({
      address: addr,
      vault: vaultByAddr.get(addr)!,
      // A node can be "known" (resolved vault, full identity) yet still flagged
      // as unknown when its governor isn't part of any declared product entity
      // — same signal as the per-pair "Unknown" risk-manager pill. Keep the
      // logo/symbol but render the red badge in either case.
      isUnknown: unknownSet.has(addr),
    })),
    ...[...connectedUnknownAddresses].map(addr => ({ address: addr, vault: undefined, isUnknown: true })),
    // Disconnected nodes are always group members; group members are never
    // tracked in unknownCollateral (the curator's label is an attestation).
    ...disconnectedVaults.map(d => ({ ...d, isUnknown: false })),
  ]
  const count = allNodeEntries.length
  const baseR = Math.min(24, 10 + count * 2)
  const stretch = count > 6 ? 1.6 : count > 3 ? 1.3 : 1.0
  const rx = baseR * stretch
  const ry = baseR
  const cx = rx + 8
  const cy = 30
  const assetSymbols = new Set<string>()

  const nodes: MiniNode[] = allNodeEntries.map(({ address, vault, isUnknown }, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(count, 1) - Math.PI / 2
    // Placeholder nodes have no asset metadata. Use the truncated vault
    // address as the label so the curator can identify the missing entry,
    // and let the standard logo-less fallback (stringToColor + 2-char head)
    // handle the visual — the red badge alone signals the unknown state.
    const assetSymbol = vault ? getVaultAssetSymbol(vault) : truncate(address)
    const assetAddress = vault ? getVaultAssetAddress(vault) : ''
    // Resolvable nodes still contribute to "X assets" even when flagged as
    // unknown (USDC stays USDC; only the badge is added). The asset count is
    // suppressed only for placeholder nodes that have no resolved vault data.
    if (vault) assetSymbols.add(assetSymbol)
    return {
      address,
      assetAddress,
      assetSymbol,
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
      hasVaultData: Boolean(vault),
      isUnknown,
    }
  })
  const nodeMap = new Map(nodes.map(n => [n.address, n]))

  const seenPairs = new Set<string>()
  const edges: MiniEdge[] = []

  for (const key of displayEdges) {
    const [fromAddr, toAddr] = key.split(':')
    const pairKey = [fromAddr, toAddr].sort().join(':')
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)

    const fromNode = nodeMap.get(fromAddr)
    const toNode = nodeMap.get(toAddr)
    if (!fromNode || !toNode) continue

    const reverseExists = displayEdges.has(`${toAddr}:${fromAddr}`)
    edges.push({ from: fromNode, to: toNode, mutual: reverseExists })
  }

  const viewWidth = (cx + rx + 8)
  return { nodes, edges, pairCount: directedEdges.size, assetCount: assetSymbols.size, viewWidth }
}

// ============================================================
// Collateral Matrix
// ============================================================

export const getCollateralMatrix = (market: MarketGroup): CollateralMatrixData | null => {
  const borrowable = getDiscoveryColumnVaults(market)
  const nonBorrowable = getDiscoveryRowOnlyVaults(market)

  const knownAddresses = new Set<string>()
  for (const v of [...market.vaults, ...market.externalCollateral]) {
    const addr = getVaultAddress(v).toLowerCase()
    if (addr) knownAddresses.add(addr)
  }

  const cells = new Map<string, Map<string, MatrixCell>>()
  const referencedCollateral = new Set<string>()
  const connectedBorrowable = new Set<string>()
  let pairCount = 0

  for (const vault of borrowable) {
    for (const ltv of vault.collaterals) {
      if (!isLiveCollateralEdge(ltv)) continue
      const colAddr = ltv.address.toLowerCase()
      if (!knownAddresses.has(colAddr)) continue

      referencedCollateral.add(colAddr)
      connectedBorrowable.add(vault.address.toLowerCase())
      if (ltv.borrowLTV > 0) pairCount++

      const colMap = cells.get(colAddr) ?? new Map<string, MatrixCell>()
      colMap.set(vault.address.toLowerCase(), { ltv })
      cells.set(colAddr, colMap)
    }
  }

  if (cells.size === 0) return null

  const rowAvgLTV = (addr: string): number => {
    const rowCells = cells.get(addr)
    if (!rowCells || rowCells.size === 0) return 0
    let sum = 0
    for (const cell of rowCells.values()) sum += Number(ltvToPercent(cell.ltv.borrowLTV))
    return sum / rowCells.size
  }

  const colAvgLTV = (addr: string): number => {
    let sum = 0
    let count = 0
    for (const [, rowCells] of cells) {
      const cell = rowCells.get(addr)
      if (cell) {
        sum += Number(ltvToPercent(cell.ltv.borrowLTV))
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  const combinedAvgLTV = (addr: string): number => (rowAvgLTV(addr) + colAvgLTV(addr)) / 2

  const inBothAxes: EVault[] = []
  const rowOnlyBorrowable: EVault[] = []
  const colOnlyBorrowable: EVault[] = []

  for (const v of borrowable) {
    const addr = v.address.toLowerCase()
    const inRows = referencedCollateral.has(addr)
    const inCols = connectedBorrowable.has(addr)
    if (inRows && inCols) inBothAxes.push(v)
    else if (inRows) rowOnlyBorrowable.push(v)
    else if (inCols) colOnlyBorrowable.push(v)
  }

  const sortedDiagonal = [...inBothAxes].sort((a, b) =>
    combinedAvgLTV(b.address.toLowerCase()) - combinedAvgLTV(a.address.toLowerCase()),
  )
  const sortedRowOnly = [...rowOnlyBorrowable].sort((a, b) =>
    rowAvgLTV(b.address.toLowerCase()) - rowAvgLTV(a.address.toLowerCase()),
  )
  const sortedColOnly = [...colOnlyBorrowable].sort((a, b) =>
    colAvgLTV(b.address.toLowerCase()) - colAvgLTV(a.address.toLowerCase()),
  )

  const rows: CollateralMatrixData['rows'] = []
  const seenRows = new Set<string>()

  const addRow = (addr: string, symbol: string, assetAddress: string, category: CollateralMatrixData['rows'][0]['category']) => {
    if (seenRows.has(addr)) return
    seenRows.add(addr)
    rows.push({ address: addr, symbol, assetAddress, category })
  }

  for (const v of sortedDiagonal) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'borrowable')
  for (const v of sortedRowOnly) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'borrowable')

  // Escrow + external rows always render at the bottom, even when no
  // borrowable vault references them, so curators can see same-asset escrow
  // and external collateral at a glance. Rows without cells appear empty —
  // the dim styling on the label conveys that they're inventory, not active.
  const sortedNonBorrowable = [...nonBorrowable]
    .sort((a, b) => rowAvgLTV(b.address.toLowerCase()) - rowAvgLTV(a.address.toLowerCase()))
  for (const v of sortedNonBorrowable) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'escrow')

  const securitizeMembers = market.vaults
    .filter(isSecuritizeVault)
    .sort((a, b) => rowAvgLTV(b.address.toLowerCase()) - rowAvgLTV(a.address.toLowerCase()))
  for (const v of securitizeMembers) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'external')

  const sortedExternal = market.externalCollateral
    .filter(isMatrixCompatibleVault)
    .slice()
    .sort((a, b) => rowAvgLTV(getVaultAddress(b).toLowerCase()) - rowAvgLTV(getVaultAddress(a).toLowerCase()))
  for (const v of sortedExternal) addRow(getVaultAddress(v).toLowerCase(), getVaultAssetSymbol(v), getVaultAssetAddress(v), 'external')

  const columns: CollateralMatrixData['columns'] = [
    ...sortedDiagonal.map(v => ({ address: v.address.toLowerCase(), symbol: v.asset.symbol, assetAddress: v.asset.address })),
    ...sortedColOnly.map(v => ({ address: v.address.toLowerCase(), symbol: v.asset.symbol, assetAddress: v.asset.address })),
  ]

  return { rows, columns, cells, pairCount }
}

// ============================================================
// Metric Formatting
// ============================================================

export const formatMetricValue = (value: number, metric: DotMetric): string => {
  switch (metric) {
    case 'multiplier':
      return `${formatNumber(value, 1, 1)}x`
    case 'oracle':
      return ''
    default:
      return `${formatNumber(value, 1, 1)}%`
  }
}

// ============================================================
// Graph Geometry
// ============================================================

export const estimateLabelWidth = (symbol: string): number => symbol.length * 7

export const getEnlargedDiagram = (diagram: MiniDiagramData) => {
  const { nodes, edges } = diagram
  const count = nodes.length
  const baseR = Math.min(120, 40 + count * 12)

  const stretch = count > 6 ? 1.6 : count > 3 ? 1.3 : 1.0
  const rx = baseR * stretch
  const ry = baseR

  const labelOffset = 20
  const maxLabelWidth = Math.max(...nodes.map(n => estimateLabelWidth(n.assetSymbol)), 0)
  const marginX = rx + labelOffset + maxLabelWidth + 12
  const marginY = ry + labelOffset + 16 + 12

  const cx = marginX
  const cy = marginY
  const viewWidth = marginX * 2
  const viewHeight = marginY * 2
  const nodeRadius = 12

  const enlargedNodes = nodes.map((node, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(count, 1) - Math.PI / 2
    return {
      ...node,
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    }
  })

  const nodeMap = new Map(enlargedNodes.map(n => [n.address, n]))

  const enlargedEdges = edges.map(edge => ({
    ...edge,
    from: nodeMap.get(edge.from.address)!,
    to: nodeMap.get(edge.to.address)!,
  }))

  return { nodes: enlargedNodes, edges: enlargedEdges, viewWidth, viewHeight, cx, cy, nodeRadius }
}

export const ARROW_SIZE = 6

export const getArrow = (fromX: number, fromY: number, toX: number, toY: number, nodeR: number) => {
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist === 0) return { lineX2: toX, lineY2: toY, triangle: '' }
  const ux = dx / dist
  const uy = dy / dist
  const tipX = toX - ux * nodeR
  const tipY = toY - uy * nodeR
  const baseX = tipX - ux * ARROW_SIZE
  const baseY = tipY - uy * ARROW_SIZE
  const px = -uy * (ARROW_SIZE * 0.5)
  const py = ux * (ARROW_SIZE * 0.5)
  const triangle = `${tipX},${tipY} ${baseX + px},${baseY + py} ${baseX - px},${baseY - py}`
  return { lineX2: baseX, lineY2: baseY, triangle }
}

export const getLabelPosition = (node: { x: number, y: number }, cx: number, cy: number) => {
  const dx = node.x - cx
  const dy = node.y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist === 0) return { x: node.x, y: node.y - 22, anchor: 'middle' as const }
  const nx = dx / dist
  const ny = dy / dist
  const offset = 20
  const anchor = nx < -0.3 ? 'end' as const : nx > 0.3 ? 'start' as const : 'middle' as const
  return { x: node.x + nx * offset, y: node.y + ny * offset + 4, anchor }
}

export const getGraphConnectedAddresses = (diagram: MiniDiagramData, address: string): Set<string> => {
  const connected = new Set<string>()
  for (const edge of diagram.edges) {
    if (edge.from.address === address) connected.add(edge.to.address)
    if (edge.to.address === address) connected.add(edge.from.address)
  }
  return connected
}

export const isNodeRampingDown = (market: MarketGroup, address: string): boolean => {
  const normalized = address.toLowerCase()
  const vault = market.vaults
    .filter(isEVault)
    .find(v => v.address.toLowerCase() === normalized)

  return vault?.collaterals.some(ltv => ltv.isLiquidationLTVRamping) ?? false
}

// ============================================================
// Color Functions
// ============================================================

export const getLtvColor = (pct: number): string => {
  const t = Math.max(0, Math.min(100, pct)) / 100
  const alpha = 0.1 + t * 0.2
  if (t < 0.75) {
    const hue = 145 - (t / 0.75) * 100 // green(145) -> yellow(45)
    return `hsla(${hue}, 70%, 45%, ${alpha})`
  }
  const hue = 45 - ((t - 0.75) / 0.25) * 45 // yellow(45) -> red(0)
  return `hsla(${hue}, 75%, 45%, ${alpha})`
}

export const getDivergingColor = (value: number, min: number, max: number): string => {
  if (min >= max || Math.abs(value) < 0.01) return 'transparent'
  if (value > 0) {
    const t = Math.min(value / (max || 1), 1)
    return `hsla(145, 70%, 45%, ${0.08 + t * 0.22})`
  }
  const t = Math.min(Math.abs(value) / (Math.abs(min) || 1), 1)
  return `hsla(0, 75%, 48%, ${0.08 + t * 0.22})`
}

export const getCellBgColor = (value: number, metric: DotMetric, min: number, max: number): string => {
  switch (metric) {
    case 'bltv':
    case 'lltv':
      return getLtvColor(value)
    case 'multiplier': {
      const equivalentLtv = value > 1 ? (1 - 1 / value) * 100 : 0
      return getLtvColor(equivalentLtv)
    }
    case 'net-apy':
    case 'roe':
      return getDivergingColor(value, min, max)
    case 'oracle':
      return 'transparent'
  }
}

// ============================================================
// Attribute Matrix (Configuration & Stats)
// ============================================================

export const isMatrixCompatibleVault = (v: AnyVault): v is EVault | SecuritizeCollateralVault =>
  isEVault(v) || isSecuritizeVault(v)

export interface VaultUsdCacheEntry {
  supply: string
  supplyUsd: number
  borrow: string
  borrowUsd: number
  liquidity: string
  liquidityUsd: number
  supplyCap: string
  supplyCapUsd: number | undefined
  borrowCap: string
  borrowCapUsd: number | undefined
}

// Pre-computed APYs that fold in intrinsic + rewards. Computed in the component
// where composables are accessible, then passed to the matrix as a cache so the
// Stats matrix renders the same APY users see on the per-vault cards.
export interface VaultApyCacheEntry {
  supplyApy: number
  borrowApy: number
}

export interface AttributeCell {
  display: string
  numeric?: number
  hint?: string
  kind?: 'text' | 'capProgress' | 'governor' | 'hooks'
  capPercent?: number
  capUncapped?: boolean
  hookable?: boolean
}

export interface AttributeRow {
  id: string
  label: string
  tooltip?: string
  getValue: (
    vault: EVault | SecuritizeCollateralVault,
    usd: VaultUsdCacheEntry | undefined,
    apy: VaultApyCacheEntry | undefined,
  ) => AttributeCell
}

export interface AttributeMatrixColumn {
  address: string
  symbol: string
  assetAddress: string
  vault: EVault | SecuritizeCollateralVault
  isExternal: boolean
}

export interface AttributeMatrixData {
  rows: AttributeRow[]
  columns: AttributeMatrixColumn[]
}

const isEscrow = (v: EVault | SecuritizeCollateralVault): boolean =>
  isEVault(v) && useVaultRegistry().getVaultCategory(v.address) === 'escrow'

const compareSymbolAsc = (a: EVault | SecuritizeCollateralVault, b: EVault | SecuritizeCollateralVault): number =>
  a.asset.symbol.localeCompare(b.asset.symbol, undefined, { sensitivity: 'base' })

// Members come first; externals (escrowed / cross-product collateral) are
// appended at the end with `isExternal: true` so the view can dim them.
export const getAttributeMatrixColumns = (market: MarketGroup): AttributeMatrixColumn[] => {
  const memberEVaults: EVault[] = []
  const memberSecuritize: SecuritizeCollateralVault[] = []
  for (const v of market.vaults) {
    if (isEVault(v)) memberEVaults.push(v)
    else if (isSecuritizeVault(v)) memberSecuritize.push(v)
  }

  memberEVaults.sort(compareSymbolAsc)
  memberSecuritize.sort(compareSymbolAsc)

  const externalEvk: EVault[] = []
  const externalSecuritize: SecuritizeCollateralVault[] = []
  const seenExternal = new Set<string>()
  for (const v of market.externalCollateral) {
    const addr = getVaultAddress(v).toLowerCase()
    if (!addr || seenExternal.has(addr)) continue
    seenExternal.add(addr)
    if (isEVault(v)) externalEvk.push(v)
    else if (isSecuritizeVault(v)) externalSecuritize.push(v)
  }

  externalEvk.sort(compareSymbolAsc)
  externalSecuritize.sort(compareSymbolAsc)

  const toCol = (vault: EVault | SecuritizeCollateralVault, isExternal: boolean): AttributeMatrixColumn => ({
    address: getVaultAddress(vault).toLowerCase(),
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    vault,
    isExternal,
  })

  return [
    ...memberEVaults.map(v => toCol(v, false)),
    ...memberSecuritize.map(v => toCol(v, false)),
    ...externalEvk.map(v => toCol(v, true)),
    ...externalSecuritize.map(v => toCol(v, true)),
  ]
}

const NA_CELL: AttributeCell = { display: '—', kind: 'text' }

// Shared cap renderer used by both the attribute matrix (CONFIG_ROWS) and the
// USD cache loader in DiscoveryMarketAccordion. `formatted` is the pre-built
// USD or asset-amount string when available; the boundary cases (uncapped /
// zero cap) win regardless of whether the formatted string is supplied.
export const formatCapDisplay = (
  rawCap: bigint,
  formatted: string | null | undefined,
): { display: string, hint?: string } => {
  if (rawCap >= maxUint256) return { display: '∞' }
  if (rawCap === 0n) return { display: '$0' }
  return { display: formatted ?? '…' }
}

const getIrmTypeLabel = (t: number | undefined): string => {
  if (t === INTEREST_RATE_MODEL_TYPE.KINK) return 'Kink'
  if (t === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) return 'Adaptive'
  if (t === INTEREST_RATE_MODEL_TYPE.KINKY) return 'Kinky'
  return '—'
}

const formatCapPercentDisplay = (pct: number, uncapped: boolean, exceeded: boolean): string => {
  if (uncapped) return '—'
  // Both the supply > supplyCap case and the supplyCap === 0n / supply > 0n
  // edge case collapse to one visual signal: '>100%'. Without this, an
  // exceeded cap was displayed as exactly 100%, which read as 'at cap' rather
  // than 'over'.
  if (exceeded || pct > 100) return '>100%'
  const factor = 100
  const displayedPct = Math.floor((pct + Number.EPSILON) * factor) / factor
  return `${compactNumber(displayedPct, 2)}%`
}

// SDK APY helpers already return percentage values (e.g. 5.2 for 5.2%) —
// matches VaultOverviewBlockStats. No further scaling needed.
const supplyApyPercent = (vault: EVault | SecuritizeCollateralVault): number =>
  Number(getVaultSupplyApy(vault))

const borrowApyPercent = (vault: EVault | SecuritizeCollateralVault): number =>
  Number(getVaultBorrowApy(vault))

export const CONFIG_ROWS: AttributeRow[] = [
  {
    id: 'supplyCap',
    label: 'Supply cap',
    getValue: (vault, usd) => {
      const rawCap = isEVault(vault) ? vault.caps.supplyCap : vault.supplyCap
      const { display } = formatCapDisplay(rawCap, usd?.supplyCap)
      return { display, kind: 'text' }
    },
  },
  {
    id: 'borrowCap',
    label: 'Borrow cap',
    getValue: (vault, usd) => {
      if (!isEVault(vault)) return NA_CELL
      if (isEscrow(vault)) return NA_CELL
      const rawCap = vault.caps.borrowCap
      const { display } = formatCapDisplay(rawCap, usd?.borrowCap)
      return { display, kind: 'text' }
    },
  },
  {
    id: 'irmType',
    label: 'Interest rate model',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const t = vault.interestRateModel.type
      const label = isVaultCyclicalNote(vault.address)
        ? 'Cyclical note'
        : getIrmTypeLabel(typeof t === 'number' ? t : undefined)
      return { display: label, kind: 'text', hint: vault.interestRateModel.address }
    },
  },
  {
    id: 'interestFee',
    label: 'Interest fee',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const pct = vault.fees.interestFee * 100
      return { display: `${formatNumber(pct)}%`, kind: 'text' }
    },
  },
  {
    id: 'maxLiqDiscount',
    label: 'Max liquidation discount',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const pct = getMaxLiquidationDiscountDisplayPercent(vault)
      return { display: `${formatNumber(pct, 2, 0)}%`, kind: 'text' }
    },
  },
  {
    id: 'badDebtSocialised',
    label: 'Bad debt socialization',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const yes = vault.liquidation.socializeDebt
      return { display: yes ? 'Yes' : 'No', kind: 'text' }
    },
  },
  {
    id: 'hooks',
    label: 'Hooked operations',
    getValue: (vault) => {
      if (!isEVault(vault)) return NA_CELL
      const hookedOperations = getVaultHookedOperations(vault)
      // 'All' when the vault is effectively paused. Specific op summary
      // otherwise. 'None' when no ops are hooked.
      const display = isVaultEffectivelyPaused(vault)
        ? 'All'
        : !hasAnyHookedOperation(hookedOperations)
            ? 'None'
            : formatHookedOpsSummary(getHookedOperationMetas(hookedOperations))
      return {
        display,
        kind: 'hooks',
        hookable: hasAnyHookedOperation(hookedOperations),
      }
    },
  },
  {
    id: 'governor',
    label: 'Governor',
    getValue: (vault) => {
      const governor = 'governorAdmin' in vault ? vault.governorAdmin : vault.governor
      return {
        display: governor,
        kind: 'governor',
        hint: governor,
      }
    },
  },
]

export const STATS_ROWS: AttributeRow[] = [
  {
    id: 'totalSupply',
    label: 'Total supply',
    getValue: (_vault, usd) => ({
      display: usd ? usd.supply : '…',
      numeric: usd?.supplyUsd,
      kind: 'text',
    }),
  },
  {
    id: 'totalBorrow',
    label: 'Total borrows',
    getValue: (vault, usd) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      return {
        display: usd ? usd.borrow : '…',
        numeric: usd?.borrowUsd,
        kind: 'text',
      }
    },
  },
  {
    id: 'liquidity',
    label: 'Available liquidity',
    getValue: (vault, usd) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      return {
        display: usd ? usd.liquidity : '…',
        numeric: usd?.liquidityUsd,
        kind: 'text',
      }
    },
  },
  {
    id: 'utilization',
    label: 'Utilization',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const pct = vault.utilization
      return { display: `${formatNumber(pct, 2)}%`, numeric: pct, kind: 'text' }
    },
  },
  {
    id: 'supplyCapUsage',
    label: 'Supply cap usage',
    getValue: (vault) => {
      if (!isEVault(vault)) return NA_CELL
      const uncapped = vault.caps.supplyCap >= maxUint256
      const pct = vault.caps.supplyCapUtilization
      const exceeded = vault.caps.supplyCap === 0n && vault.totalAssets > 0n
      return {
        display: formatCapPercentDisplay(pct, uncapped, exceeded),
        numeric: uncapped ? undefined : pct,
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
      }
    },
  },
  {
    id: 'borrowCapUsage',
    label: 'Borrow cap usage',
    getValue: (vault) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const uncapped = vault.caps.borrowCap >= maxUint256
      const pct = vault.caps.borrowCapUtilization
      const exceeded = vault.caps.borrowCap === 0n && vault.totalBorrowed > 0n
      return {
        display: formatCapPercentDisplay(pct, uncapped, exceeded),
        numeric: uncapped ? undefined : pct,
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
      }
    },
  },
  {
    id: 'supplyApy',
    label: 'Supply APY',
    getValue: (vault, _usd, apy) => {
      // Securitize vaults have no usable interest-rate display,
      // so we'd render "0.00%" — avoid that misleading display.
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      // Prefer the pre-computed APY (folds in intrinsic + supply rewards) so
      // this matches the per-vault card. Fall back to the raw IRM rate when
      // the cache hasn't been populated (e.g. unit tests).
      const pct = apy?.supplyApy ?? supplyApyPercent(vault)
      return { display: `${formatNumber(pct, 2)}%`, numeric: pct, kind: 'text' }
    },
  },
  {
    id: 'borrowApy',
    label: 'Borrow APY',
    getValue: (vault, _usd, apy) => {
      if (!isEVault(vault) || isEscrow(vault)) return NA_CELL
      const pct = apy?.borrowApy ?? borrowApyPercent(vault)
      return { display: `${formatNumber(pct, 2)}%`, numeric: pct, kind: 'text' }
    },
  },
]

// Build a per-vault APY cache. Mirrors the per-vault card formula: supply APY
// includes LEND rewards (viewer-filtered), borrow APY subtracts BORROW rewards
// (general only — no collateral context, since the matrix shows per-vault
// stats, not per-pair).
export const buildVaultApyCache = (
  markets: MarketGroup[],
  viewer: string | undefined,
  settings: ApyVisibilitySettings,
): Map<string, VaultApyCacheEntry> => {
  const result = new Map<string, VaultApyCacheEntry>()
  for (const market of markets) {
    // Walk both members and external collateral — the attribute matrix now
    // renders externals as columns too, and they need the same intrinsic +
    // rewards adjustment so Stats agrees with the per-vault card.
    for (const vault of [...market.vaults, ...market.externalCollateral]) {
      if (!isVaultType(vault)) continue
      const addr = vault.address.toLowerCase()
      if (result.has(addr)) continue
      if (!isEVault(vault)) {
        const baseSupply = supplyApyPercent(vault)
        result.set(addr, { supplyApy: baseSupply, borrowApy: 0 })
        continue
      }
      result.set(addr, {
        supplyApy: computeSupplyApy(vault, viewer, settings),
        // No collateral context here: BORROW_COLLATERAL is intentionally excluded.
        borrowApy: computeBorrowApy(vault, viewer, settings, undefined),
      })
    }
  }
  return result
}

export const getAttributeMatrix = (
  market: MarketGroup,
  mode: AttributeMatrixMode,
): AttributeMatrixData => ({
  rows: mode === 'config' ? CONFIG_ROWS : STATS_ROWS,
  columns: getAttributeMatrixColumns(market),
})

export const buildAttributeRowCells = (
  row: AttributeRow,
  columns: AttributeMatrixColumn[],
  usdCache: Map<string, VaultUsdCacheEntry>,
  apyCache?: Map<string, VaultApyCacheEntry>,
): AttributeCell[] =>
  columns.map(col => row.getValue(
    col.vault,
    usdCache.get(col.address),
    apyCache?.get(col.address),
  ))
