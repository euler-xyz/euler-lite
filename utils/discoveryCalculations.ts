import { maxUint256 } from 'viem'
import type { MarketGroup, MiniDiagramData, MiniNode, MiniEdge } from '~/entities/lend-discovery'
import type { Vault, SecuritizeVault, VaultCollateralLTV } from '~/entities/vault'
import type { AnyVault } from '~/composables/useVaultRegistry'
import type { EulerLabelEntity } from '~/entities/euler/labels'
import { getCurrentLiquidationLTV, isLiquidationLTVRamping, getVaultUtilization } from '~/entities/vault'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getEntitiesByVault, isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { nanoToValue } from '~/utils/crypto-utils'
import { formatNumber, compactNumber } from '~/utils/string-utils'
import { decodeHookedOps, formatHookedOpsSummary, isVaultEffectivelyPaused } from '~/utils/vault-hooks'
import { getSupplyCapPercentage, getBorrowCapPercentage } from '~/composables/useVaultWarnings'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'

// ============================================================
// Types & Constants
// ============================================================

export interface MatrixCell {
  ltv: VaultCollateralLTV
}

export interface CollateralMatrixData {
  rows: Array<{ address: string, symbol: string, assetAddress: string, category: 'escrow' | 'external' | 'borrowable' }>
  columns: Array<{ address: string, symbol: string, assetAddress: string }>
  cells: Map<string, Map<string, MatrixCell>>
  pairCount: number
}

export interface BestMaxRoeResult {
  value: number
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
  { id: 'oracle', label: 'Oracle', higherIsBetter: false },
]

export type ExpandedViewMode = 'graph' | 'matrix'

export type MatrixVariant = 'pairs' | 'config' | 'stats'
export type AttributeMatrixMode = 'config' | 'stats'

// ============================================================
// Vault Type Guards & Accessors
// ============================================================

export const isVaultType = (vault: AnyVault): vault is Vault =>
  !('type' in vault) || (vault as { type?: string }).type === undefined

export const getVaultAddress = (vault: AnyVault): string =>
  isVaultType(vault) ? vault.address : ('address' in vault ? (vault as { address: string }).address : '')

export const getVaultAssetSymbol = (vault: AnyVault): string => {
  if (isVaultType(vault)) return vault.asset.symbol
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object') {
    const asset = vault.asset as unknown as Record<string, unknown>
    if ('symbol' in asset && typeof asset.symbol === 'string') return asset.symbol
  }
  return '?'
}

export const getVaultAssetAddress = (vault: AnyVault): string => {
  if (isVaultType(vault)) return vault.asset.address
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object') {
    const asset = vault.asset as unknown as Record<string, unknown>
    if ('address' in asset && typeof asset.address === 'string') return asset.address
  }
  return ''
}

// ============================================================
// Market Data Helpers
// ============================================================

export const getDeprecatedVaultCount = (market: MarketGroup): number =>
  market.vaults.filter((v) => {
    const addr = getVaultAddress(v)
    return addr ? isVaultDeprecated(addr) : false
  }).length

export const getMarketEntities = (market: MarketGroup): { name: string, logos: string[] } => {
  const seen = new Set<string>()
  const all: EulerLabelEntity[] = []
  for (const v of market.vaults) {
    if (!isVaultType(v)) continue
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

const hasBorrowableLTV = (vault: Vault): boolean =>
  vault.collateralLTVs.some(ltv => ltv.borrowLTV > 0n)

export const getBorrowableVaults = (market: MarketGroup): Vault[] =>
  market.vaults.filter(isVaultType).filter(hasBorrowableLTV)

export const getNonBorrowableMemberVaults = (market: MarketGroup): Vault[] =>
  market.vaults.filter(isVaultType).filter(v => !hasBorrowableLTV(v))

export const isExternalCollateral = (market: MarketGroup, address: string): boolean => {
  const normalized = address.toLowerCase()
  return market.externalCollateral.some(v => getVaultAddress(v).toLowerCase() === normalized)
}

export const getActiveExternalCollateral = (market: MarketGroup): AnyVault[] => {
  const borrowableVaults = getBorrowableVaults(market)
  return market.externalCollateral.filter((ext) => {
    const extAddr = getVaultAddress(ext).toLowerCase()
    return borrowableVaults.some(v =>
      v.collateralLTVs.some(ltv =>
        ltv.collateral.toLowerCase() === extAddr && ltv.liquidationLTV > 0n,
      ),
    )
  })
}

export const findVault = (market: MarketGroup, address: string): Vault | SecuritizeVault | null => {
  const normalized = address.toLowerCase()
  for (const v of market.vaults) {
    if (getVaultAddress(v).toLowerCase() === normalized) return v as Vault | SecuritizeVault
  }
  for (const v of market.externalCollateral) {
    if (getVaultAddress(v).toLowerCase() === normalized) return v as Vault | SecuritizeVault
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

  const directedEdges = new Set<string>()
  const displayEdges = new Set<string>()
  const connectedAddresses = new Set<string>()

  for (const vault of market.vaults) {
    if (!isVaultType(vault)) continue
    for (const ltv of vault.collateralLTVs) {
      const colAddr = ltv.collateral.toLowerCase()
      if (!vaultByAddr.has(colAddr)) continue
      const liabAddr = vault.address.toLowerCase()
      if (ltv.borrowLTV > 0n) {
        directedEdges.add(`${colAddr}:${liabAddr}`)
      }
      if (getCurrentLiquidationLTV(ltv) > 0n) {
        displayEdges.add(`${colAddr}:${liabAddr}`)
        connectedAddresses.add(colAddr)
        connectedAddresses.add(liabAddr)
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

  if (connectedAddresses.size === 0 && disconnectedVaults.length === 0) {
    const assetSymbols = new Set<string>()
    for (const v of market.vaults) assetSymbols.add(getVaultAssetSymbol(v))
    return { nodes: [], edges: [], pairCount: 0, assetCount: assetSymbols.size, viewWidth: 0 }
  }

  const allNodeEntries = [
    ...[...connectedAddresses].map(addr => ({ address: addr, vault: vaultByAddr.get(addr)! })),
    ...disconnectedVaults,
  ]
  const count = allNodeEntries.length
  const baseR = Math.min(24, 10 + count * 2)
  const stretch = count > 6 ? 1.6 : count > 3 ? 1.3 : 1.0
  const rx = baseR * stretch
  const ry = baseR
  const cx = rx + 8
  const cy = 30
  const assetSymbols = new Set<string>()

  const nodes: MiniNode[] = allNodeEntries.map(({ address, vault }, i) => {
    const angle = (Math.PI * 2 * i) / Math.max(count, 1) - Math.PI / 2
    const assetSymbol = vault ? getVaultAssetSymbol(vault) : '?'
    const assetAddress = vault ? getVaultAssetAddress(vault) : ''
    assetSymbols.add(assetSymbol)
    return { address, assetAddress, assetSymbol, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
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
  const borrowable = getBorrowableVaults(market)
  const nonBorrowable = getNonBorrowableMemberVaults(market)
  const external = getActiveExternalCollateral(market)

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
    for (const ltv of vault.collateralLTVs) {
      if (getCurrentLiquidationLTV(ltv) <= 0n) continue
      const colAddr = ltv.collateral.toLowerCase()
      if (!knownAddresses.has(colAddr)) continue

      referencedCollateral.add(colAddr)
      connectedBorrowable.add(vault.address.toLowerCase())
      if (ltv.borrowLTV > 0n) pairCount++

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
    for (const cell of rowCells.values()) sum += Number(nanoToValue(cell.ltv.borrowLTV, 2))
    return sum / rowCells.size
  }

  const colAvgLTV = (addr: string): number => {
    let sum = 0
    let count = 0
    for (const [, rowCells] of cells) {
      const cell = rowCells.get(addr)
      if (cell) {
        sum += Number(nanoToValue(cell.ltv.borrowLTV, 2))
        count++
      }
    }
    return count > 0 ? sum / count : 0
  }

  const combinedAvgLTV = (addr: string): number => (rowAvgLTV(addr) + colAvgLTV(addr)) / 2

  const inBothAxes: Vault[] = []
  const rowOnlyBorrowable: Vault[] = []
  const colOnlyBorrowable: Vault[] = []

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
    if (referencedCollateral.has(addr) && !seenRows.has(addr)) {
      seenRows.add(addr)
      rows.push({ address: addr, symbol, assetAddress, category })
    }
  }

  for (const v of sortedDiagonal) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'borrowable')
  for (const v of sortedRowOnly) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'borrowable')

  const sortedNonBorrowable = [...nonBorrowable]
    .filter(v => referencedCollateral.has(v.address.toLowerCase()))
    .sort((a, b) => rowAvgLTV(b.address.toLowerCase()) - rowAvgLTV(a.address.toLowerCase()))
  for (const v of sortedNonBorrowable) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'escrow')

  const securitizeMembers = market.vaults
    .filter((v): v is SecuritizeVault => 'type' in v && (v as { type?: string }).type === 'securitize')
    .filter(v => referencedCollateral.has(v.address.toLowerCase()))
    .sort((a, b) => rowAvgLTV(b.address.toLowerCase()) - rowAvgLTV(a.address.toLowerCase()))
  for (const v of securitizeMembers) addRow(v.address.toLowerCase(), v.asset.symbol, v.asset.address, 'external')

  const sortedExternal = [...external]
    .filter(v => referencedCollateral.has(getVaultAddress(v).toLowerCase()))
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
  for (const v of market.vaults) {
    if (!isVaultType(v)) continue
    for (const ltv of v.collateralLTVs) {
      if (ltv.collateral.toLowerCase() === normalized && isLiquidationLTVRamping(ltv)) return true
    }
  }
  return false
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

// Re-export vault helpers for convenience
export { isLiquidationLTVRamping, getCurrentLiquidationLTV, getVaultUtilization } from '~/entities/vault'

// ============================================================
// Attribute Matrix (Configuration & Stats)
// ============================================================

const isSecuritizeVault = (v: AnyVault): v is SecuritizeVault =>
  'type' in v && (v as { type?: string }).type === 'securitize'

export const isMatrixCompatibleVault = (v: AnyVault): v is Vault | SecuritizeVault =>
  isVaultType(v) || isSecuritizeVault(v)

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

export type AttributeDirection = 'higher-better' | 'lower-better' | 'neutral'

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
  direction: AttributeDirection
  getValue: (vault: Vault | SecuritizeVault, usd: VaultUsdCacheEntry | undefined) => AttributeCell
}

export interface AttributeMatrixColumn {
  address: string
  symbol: string
  assetAddress: string
  vault: Vault | SecuritizeVault
}

export interface AttributeMatrixData {
  rows: AttributeRow[]
  columns: AttributeMatrixColumn[]
}

const getTotalAssets = (vault: Vault | SecuritizeVault): bigint =>
  (vault.totalAssets ?? 0n) as bigint

const isEscrow = (v: Vault | SecuritizeVault): boolean =>
  isVaultType(v) && v.vaultCategory === 'escrow'

export const getAttributeMatrixColumns = (market: MarketGroup): AttributeMatrixColumn[] => {
  const memberEvk: Vault[] = []
  const memberSecuritize: SecuritizeVault[] = []
  for (const v of market.vaults) {
    if (isVaultType(v)) memberEvk.push(v)
    else if (isSecuritizeVault(v)) memberSecuritize.push(v)
  }
  const externalSecuritize: SecuritizeVault[] = []
  const seenExternal = new Set<string>()
  for (const v of market.externalCollateral) {
    if (!isSecuritizeVault(v)) continue
    const addr = getVaultAddress(v).toLowerCase()
    if (seenExternal.has(addr)) continue
    seenExternal.add(addr)
    externalSecuritize.push(v)
  }

  memberEvk.sort((a, b) => (getTotalAssets(b) > getTotalAssets(a) ? 1 : -1))
  memberSecuritize.sort((a, b) => (getTotalAssets(b) > getTotalAssets(a) ? 1 : -1))
  externalSecuritize.sort((a, b) => (getTotalAssets(b) > getTotalAssets(a) ? 1 : -1))

  const toCol = (vault: Vault | SecuritizeVault): AttributeMatrixColumn => ({
    address: getVaultAddress(vault).toLowerCase(),
    symbol: vault.asset.symbol,
    assetAddress: vault.asset.address,
    vault,
  })

  return [
    ...memberEvk.map(toCol),
    ...memberSecuritize.map(toCol),
    ...externalSecuritize.map(toCol),
  ]
}

const NA_CELL: AttributeCell = { display: '—', kind: 'text' }

const formatCapDisplay = (
  rawCap: bigint,
  usdEntry: { capStr: string, capUsd: number | undefined } | undefined,
): { display: string, hint?: string } => {
  if (rawCap >= maxUint256) return { display: '∞' }
  if (rawCap === 0n) return { display: '$0' }
  if (!usdEntry) return { display: '…' }
  return { display: usdEntry.capStr }
}

const getIrmTypeLabel = (t: number | undefined): string => {
  if (t === INTEREST_RATE_MODEL_TYPE.KINK) return 'Kink'
  if (t === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) return 'Adaptive'
  if (t === INTEREST_RATE_MODEL_TYPE.KINKY) return 'Kinky'
  if (t === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY) return 'Cyclical'
  return '—'
}

const formatCapPercentDisplay = (pct: number, uncapped: boolean): string => {
  if (uncapped) return '—'
  return `${compactNumber(pct, 2)}%`
}

const supplyApyPercent = (vault: Vault | SecuritizeVault): number =>
  Number(nanoToValue(vault.interestRateInfo.supplyAPY, 25)) * 100

const borrowApyPercent = (vault: Vault | SecuritizeVault): number =>
  Number(nanoToValue(vault.interestRateInfo.borrowAPY, 25)) * 100

export const CONFIG_ROWS: AttributeRow[] = [
  {
    id: 'supplyCap',
    label: 'Supply cap',
    direction: 'lower-better',
    getValue: (vault, usd) => {
      const rawCap = vault.supplyCap
      const uncapped = rawCap >= maxUint256
      const { display } = formatCapDisplay(rawCap, usd ? { capStr: usd.supplyCap, capUsd: usd.supplyCapUsd } : undefined)
      const pct = uncapped ? 0 : getSupplyCapPercentage(vault as Vault)
      return {
        display,
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
        numeric: uncapped ? undefined : pct,
      }
    },
  },
  {
    id: 'borrowCap',
    label: 'Borrow cap',
    direction: 'lower-better',
    getValue: (vault, usd) => {
      if (!isVaultType(vault)) return NA_CELL
      if (isEscrow(vault)) return NA_CELL
      const rawCap = vault.borrowCap
      const uncapped = rawCap >= maxUint256
      const { display } = formatCapDisplay(rawCap, usd ? { capStr: usd.borrowCap, capUsd: usd.borrowCapUsd } : undefined)
      const pct = getBorrowCapPercentage(vault)
      return {
        display,
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
        numeric: uncapped ? undefined : pct,
      }
    },
  },
  {
    id: 'maxLiqDiscount',
    label: 'Max liquidation discount',
    direction: 'neutral',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const pct = Number(vault.maxLiquidationDiscount / 100n)
      return { display: `${pct}%`, kind: 'text', numeric: pct }
    },
  },
  {
    id: 'interestFee',
    label: 'Interest fee',
    direction: 'neutral',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const pct = Number(nanoToValue(vault.interestFee, 2))
      return { display: `${formatNumber(pct)}%`, kind: 'text', numeric: pct }
    },
  },
  {
    id: 'badDebtSocialised',
    label: 'Bad debt socialised',
    direction: 'lower-better',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const yes = vault.configFlags === 0n
      return { display: yes ? 'Yes' : 'No', kind: 'text', numeric: yes ? 0 : 1 }
    },
  },
  {
    id: 'irmType',
    label: 'Interest rate model',
    direction: 'neutral',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const t = vault.irmInfo?.interestRateModelInfo?.interestRateModelType
      const label = getIrmTypeLabel(typeof t === 'number' ? t : undefined)
      return { display: label, kind: 'text', hint: vault.interestRateModelAddress }
    },
  },
  {
    id: 'governor',
    label: 'Governor',
    direction: 'neutral',
    getValue: vault => ({
      display: vault.governorAdmin,
      kind: 'governor',
      hint: vault.governorAdmin,
    }),
  },
  {
    id: 'hooks',
    label: 'Hooks',
    direction: 'neutral',
    getValue: (vault) => {
      if (!isVaultType(vault)) return NA_CELL
      const paused = isVaultEffectivelyPaused(vault)
      const display = paused
        ? 'Paused'
        : vault.hookedOps === 0n
          ? 'None'
          : formatHookedOpsSummary(decodeHookedOps(vault.hookedOps))
      return {
        display,
        kind: 'hooks',
        hookable: vault.hookedOps !== 0n,
      }
    },
  },
]

export const STATS_ROWS: AttributeRow[] = [
  {
    id: 'totalSupply',
    label: 'Total supply',
    direction: 'higher-better',
    getValue: (_vault, usd) => ({
      display: usd ? usd.supply : '…',
      kind: 'text',
      numeric: usd?.supplyUsd,
    }),
  },
  {
    id: 'totalBorrow',
    label: 'Total borrows',
    direction: 'neutral',
    getValue: (vault, usd) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      return {
        display: usd ? usd.borrow : '…',
        kind: 'text',
        numeric: usd?.borrowUsd,
      }
    },
  },
  {
    id: 'liquidity',
    label: 'Available liquidity',
    direction: 'higher-better',
    getValue: (vault, usd) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      return {
        display: usd ? usd.liquidity : '…',
        kind: 'text',
        numeric: usd?.liquidityUsd,
      }
    },
  },
  {
    id: 'utilization',
    label: 'Utilization',
    direction: 'lower-better',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const pct = getVaultUtilization(vault)
      return { display: `${formatNumber(pct, 2)}%`, kind: 'text', numeric: pct }
    },
  },
  {
    id: 'supplyCapUsage',
    label: 'Supply cap usage',
    direction: 'lower-better',
    getValue: (vault) => {
      if (!isVaultType(vault)) return NA_CELL
      const uncapped = vault.supplyCap >= maxUint256
      const pct = getSupplyCapPercentage(vault)
      return {
        display: formatCapPercentDisplay(pct, uncapped),
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
        numeric: uncapped ? undefined : pct,
      }
    },
  },
  {
    id: 'borrowCapUsage',
    label: 'Borrow cap usage',
    direction: 'lower-better',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const uncapped = vault.borrowCap >= maxUint256
      const pct = getBorrowCapPercentage(vault)
      return {
        display: formatCapPercentDisplay(pct, uncapped),
        kind: 'capProgress',
        capPercent: pct,
        capUncapped: uncapped,
        numeric: uncapped ? undefined : pct,
      }
    },
  },
  {
    id: 'supplyApy',
    label: 'Supply APY',
    direction: 'higher-better',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const pct = supplyApyPercent(vault)
      return { display: `${formatNumber(pct, 2)}%`, kind: 'text', numeric: pct }
    },
  },
  {
    id: 'borrowApy',
    label: 'Borrow APY',
    direction: 'neutral',
    getValue: (vault) => {
      if (!isVaultType(vault) || isEscrow(vault)) return NA_CELL
      const pct = borrowApyPercent(vault)
      return { display: `${formatNumber(pct, 2)}%`, kind: 'text', numeric: pct }
    },
  },
]

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
): AttributeCell[] =>
  columns.map(col => row.getValue(col.vault, usdCache.get(col.address)))

export const getAttributeRowColor = (
  value: number | undefined,
  min: number,
  max: number,
  direction: AttributeDirection,
): string => {
  if (direction === 'neutral') return 'transparent'
  if (value === undefined || !Number.isFinite(value)) return 'transparent'
  if (min === max) return 'transparent'
  const normalized = ((value - min) / (max - min)) * 100
  const clamped = Math.max(0, Math.min(100, normalized))
  if (direction === 'lower-better') return getLtvColor(clamped)
  return getLtvColor(100 - clamped)
}
