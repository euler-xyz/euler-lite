import { fetchVaults, type Vault } from '~/entities/vault'
import { logWarn } from '~/utils/errorHandling'
import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'
import type { MarketGroup, MarketGroupMetrics, CuratorGroup } from '~/entities/lend-discovery'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { getVaultUtilization } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { isVaultNotExplorable, isVaultFeatured } from '~/utils/eulerLabelsUtils'

// -- Helpers --

const isVaultType = (vault: AnyVault): vault is Vault =>
  !('type' in vault) || (vault as { type?: string }).type === undefined

const isBorrowableVault = (vault: AnyVault): boolean => {
  if (!isVaultType(vault)) return false
  if (vault.vaultCategory === 'escrow') return false
  return vault.collateralLTVs.some(ltv => ltv.borrowLTV > 0n)
}

const getCollateralAddresses = (vault: AnyVault): string[] => {
  if (!isVaultType(vault)) return []
  return vault.collateralLTVs.map(ltv => ltv.collateral)
}

const getVaultAddress = (vault: AnyVault): string =>
  isVaultType(vault) ? vault.address : ('address' in vault ? (vault as { address: string }).address : '')

const getAssetSymbol = (vault: AnyVault): string => {
  if (isVaultType(vault)) return vault.asset.symbol
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object' && 'symbol' in (vault.asset as unknown as Record<string, unknown>)) {
    return (vault.asset as unknown as { symbol: string }).symbol
  }
  return 'Unknown'
}

const getSupplyAPY = (vault: AnyVault): bigint => {
  if ('interestRateInfo' in vault && vault.interestRateInfo) {
    return vault.interestRateInfo.supplyAPY
  }
  return 0n
}

const getBorrowAPY = (vault: AnyVault): bigint => {
  if (!isVaultType(vault)) return 0n
  return vault.interestRateInfo.borrowAPY
}

// -- Step 1: Product-Label Groups --

const buildProductGroups = (
  allVaults: AnyVault[],
  products: Record<string, EulerLabelProduct>,
  entities: Record<string, EulerLabelEntity>,
): { groups: MarketGroup[], assignedAddresses: Set<string> } => {
  const vaultMap = new Map<string, AnyVault>()
  for (const vault of allVaults) {
    const addr = getVaultAddress(vault)
    if (addr) vaultMap.set(addr.toLowerCase(), vault)
  }

  const assignedAddresses = new Set<string>()
  const groups: MarketGroup[] = []

  for (const [productKey, product] of Object.entries(products)) {
    const memberVaults: AnyVault[] = []
    const allProductAddresses = [...product.vaults, ...(product.deprecatedVaults || [])]
    for (const vaultAddr of allProductAddresses) {
      const vault = vaultMap.get(vaultAddr.toLowerCase())
      if (vault) {
        memberVaults.push(vault)
        assignedAddresses.add(vaultAddr.toLowerCase())
      }
    }

    if (memberVaults.length === 0) continue

    // Resolve curator entity
    const entityKeys = Array.isArray(product.entity) ? product.entity : [product.entity]
    const curatorKey = entityKeys[0] || undefined
    const curator = curatorKey ? entities[curatorKey] : undefined

    groups.push({
      id: productKey,
      name: product.name,
      source: 'product',
      curator,
      curatorKey,
      vaults: memberVaults,
      externalCollateral: [],
      metrics: computeMetricsSync(memberVaults),
    })
  }

  return { groups, assignedAddresses }
}

// -- Step 2: Augment with Collateral Graph --

// Module-scope dedupe so we warn at most once per (vault → missing-collateral)
// pair across recomputes.
const warnedMissingCollateral = new Set<string>()

const augmentWithCollateralGraph = (
  groups: MarketGroup[],
  allVaults: AnyVault[],
): MarketGroup[] => {
  const vaultMap = new Map<string, AnyVault>()
  for (const vault of allVaults) {
    const addr = getVaultAddress(vault)
    if (addr) vaultMap.set(addr.toLowerCase(), vault)
  }

  return groups.map((group: MarketGroup): MarketGroup => {
    const groupAddresses = new Set(
      group.vaults.map((v: AnyVault) => getVaultAddress(v).toLowerCase()),
    )

    const externalCollateral: AnyVault[] = []
    const seenExternal = new Set<string>()

    for (const vault of group.vaults) {
      const vaultAddr = getVaultAddress(vault)
      const collateralAddrs = getCollateralAddresses(vault)
      for (const colAddr of collateralAddrs) {
        const normalized = colAddr.toLowerCase()
        if (groupAddresses.has(normalized) || seenExternal.has(normalized)) continue
        const externalVault = vaultMap.get(normalized)
        if (externalVault) {
          externalCollateral.push(externalVault)
          seenExternal.add(normalized)
        }
        else {
          // Curator referenced a collateral vault that isn't loaded into the
          // registry — silently dropping it would hide the relationship from
          // every discovery view. Warn once per pair so the gap is visible.
          const key = `${vaultAddr.toLowerCase()}:${normalized}`
          if (!warnedMissingCollateral.has(key)) {
            warnedMissingCollateral.add(key)
            logWarn(
              'useMarketGroups/missing-collateral',
              `Group "${group.name}": vault ${vaultAddr} references unresolved collateral ${colAddr}`,
            )
          }
        }
      }
    }

    return {
      ...group,
      externalCollateral,
    }
  })
}

// -- Step 3: Orphan Clustering --

const clusterOrphans = (
  allVaults: AnyVault[],
  assignedAddresses: Set<string>,
): MarketGroup[] => {
  const orphans = allVaults.filter((vault: AnyVault) => {
    const addr = getVaultAddress(vault)
    return addr && !assignedAddresses.has(addr.toLowerCase())
  })

  if (orphans.length === 0) return []

  // Build adjacency graph (undirected) from collateral relationships
  const addrToOrphan = new Map<string, AnyVault>()
  for (const vault of orphans) {
    const addr = getVaultAddress(vault)
    if (addr) addrToOrphan.set(addr.toLowerCase(), vault)
  }

  const orphanAddresses = new Set(addrToOrphan.keys())
  const adjacency = new Map<string, Set<string>>()
  for (const addr of orphanAddresses) {
    adjacency.set(addr, new Set())
  }

  for (const vault of orphans) {
    const addr = getVaultAddress(vault).toLowerCase()
    const collateralAddrs = getCollateralAddresses(vault)
    for (const colAddr of collateralAddrs) {
      const normalized = colAddr.toLowerCase()
      if (orphanAddresses.has(normalized) && normalized !== addr) {
        adjacency.get(addr)?.add(normalized)
        adjacency.get(normalized)?.add(addr)
      }
    }
  }

  // Connected components via BFS
  const visited = new Set<string>()
  const components: AnyVault[][] = []

  for (const addr of orphanAddresses) {
    if (visited.has(addr)) continue

    const component: AnyVault[] = []
    const queue = [addr]
    visited.add(addr)

    while (queue.length > 0) {
      const current = queue.shift()!
      const vault = addrToOrphan.get(current)
      if (vault) component.push(vault)

      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }

    if (component.length > 0) {
      components.push(component)
    }
  }

  return components.map((vaults: AnyVault[], index: number): MarketGroup => ({
    id: `orphan-${index}`,
    name: vaults.length === 1
      ? `${getAssetSymbol(vaults[0])} (Ungrouped)`
      : `Ungrouped Market #${index + 1}`,
    source: 'algorithmic',
    curator: undefined,
    curatorKey: undefined,
    vaults,
    externalCollateral: [],
    metrics: computeMetricsSync(vaults),
  }))
}

// -- Metrics Computation --

const computeMetricsSync = (vaults: AnyVault[]): MarketGroupMetrics => {
  let bestSupplyAPY = 0n
  let bestBorrowAPY = 0n
  let borrowableCount = 0
  let totalUtilization = 0
  const assetSymbols = new Set<string>()
  let hasFeatured = false

  for (const vault of vaults) {
    const supplyAPY = getSupplyAPY(vault)
    if (supplyAPY > bestSupplyAPY) bestSupplyAPY = supplyAPY

    const symbol = getAssetSymbol(vault)
    assetSymbols.add(symbol)

    const addr = getVaultAddress(vault)
    if (addr && isVaultFeatured(addr)) hasFeatured = true

    if (isBorrowableVault(vault)) {
      borrowableCount++
      const borrowAPY = getBorrowAPY(vault)
      if (bestBorrowAPY === 0n || (borrowAPY > 0n && borrowAPY < bestBorrowAPY)) {
        bestBorrowAPY = borrowAPY
      }
      if (isVaultType(vault)) {
        totalUtilization += getVaultUtilization(vault)
      }
    }
  }

  return {
    totalTVL: 0,
    allVaultsPriced: false,
    pricedVaultCount: 0,
    totalAvailableLiquidity: 0,
    totalBorrowed: 0,
    bestSupplyAPY,
    bestBorrowAPY,
    vaultCount: vaults.length,
    borrowableVaultCount: borrowableCount,
    averageUtilization: borrowableCount > 0 ? totalUtilization / borrowableCount : 0,
    assetSymbols: [...assetSymbols],
    hasFeatured,
  }
}

// -- Async TVL Resolution --

const resolveGroupTVL = async (group: MarketGroup): Promise<MarketGroup> => {
  let totalTVL = 0
  let pricedCount = 0
  let allPriced = true
  let totalAvailableLiquidity = 0
  let totalBorrowed = 0

  const results = await Promise.all(
    group.vaults.map(async (vault: AnyVault) => {
      const totalAssets = 'totalAssets' in vault ? vault.totalAssets as bigint : 0n
      const usdValue = await getAssetUsdValueOrZero(totalAssets, vault, 'off-chain')
      const borrowable = isBorrowableVault(vault)
      let liquidity = 0
      let borrowUsd = 0
      if (borrowable && usdValue > 0 && isVaultType(vault)) {
        borrowUsd = await getAssetUsdValueOrZero(vault.borrow, vault, 'off-chain')
        liquidity = usdValue - borrowUsd
      }
      return { priced: usdValue > 0, value: usdValue, liquidity, borrowUsd, borrowable }
    }),
  )

  for (const result of results) {
    if (result.priced) {
      totalTVL += result.value
      pricedCount++
      if (result.borrowable) {
        totalAvailableLiquidity += result.liquidity
        totalBorrowed += result.borrowUsd
      }
    }
    else {
      allPriced = false
    }
  }

  return {
    ...group,
    metrics: {
      ...group.metrics,
      totalTVL,
      allVaultsPriced: allPriced,
      pricedVaultCount: pricedCount,
      totalAvailableLiquidity,
      totalBorrowed,
    },
  }
}

// -- Main Composable --

export const useMarketGroups = () => {
  const { getAll } = useVaultRegistry()
  const { products, entities } = useEulerLabels()

  /** All vaults available for grouping */
  const allVaults = computed((): AnyVault[] => {
    return getAll()
      .map(entry => entry.vault)
      .filter((vault) => {
        const address = getVaultAddress(vault)
        return address ? !isVaultNotExplorable(address) : true
      })
  })

  /** Synchronous market groups (metrics without TVL) */
  const marketGroupsSync = computed((): MarketGroup[] => {
    const vaults = allVaults.value
    if (vaults.length === 0) return []

    // Step 1: Product-label groups
    const { groups: productGroups, assignedAddresses } = buildProductGroups(vaults, products, entities)

    // Step 2: Augment with collateral graph
    const augmented = augmentWithCollateralGraph(productGroups, vaults)

    // Step 3: Orphan clustering
    const orphanGroups = clusterOrphans(vaults, assignedAddresses)
    const augmentedOrphans = augmentWithCollateralGraph(orphanGroups, vaults)

    return [...augmented, ...augmentedOrphans]
  })

  /** Market groups with async TVL resolution */
  const marketGroups = ref<MarketGroup[]>([])
  const isResolvingTVL = ref(false)
  let resolveRunId = 0

  watch(
    marketGroupsSync,
    async (groups: MarketGroup[]) => {
      const runId = ++resolveRunId
      if (groups.length === 0) {
        marketGroups.value = []
        isResolvingTVL.value = false
        return
      }

      // Only show loading state on initial load — during refreshes, keep showing stale data
      const isInitialLoad = marketGroups.value.length === 0
      if (isInitialLoad) {
        isResolvingTVL.value = true
      }
      try {
        const resolved = await Promise.all(groups.map(resolveGroupTVL))
        if (runId === resolveRunId) {
          marketGroups.value = resolved
        }
      }
      catch (e) {
        logWarn('useMarketGroups', e)
        if (runId === resolveRunId) {
          marketGroups.value = groups
        }
      }
      finally {
        if (runId === resolveRunId) {
          isResolvingTVL.value = false
        }
      }
    },
    { immediate: true },
  )

  /** Curator groups derived from market groups */
  const curatorGroups = computed((): CuratorGroup[] => {
    const groups = marketGroups.value
    const byCurator = new Map<string, MarketGroup[]>()

    for (const group of groups) {
      const key = group.curatorKey || '__uncurated__'
      const existing = byCurator.get(key) || []
      byCurator.set(key, [...existing, group])
    }

    return [...byCurator.entries()].map(([key, markets]: [string, MarketGroup[]]): CuratorGroup => {
      const firstCurator = markets[0]?.curator
      const totalTVL = markets.reduce((sum: number, m: MarketGroup) => sum + m.metrics.totalTVL, 0)
      const allVaultsPriced = markets.every((m: MarketGroup) => m.metrics.allVaultsPriced)

      return {
        key,
        name: firstCurator?.name || 'Ungrouped',
        logo: firstCurator?.logo,
        markets,
        totalTVL,
        allVaultsPriced,
        pricedMarketCount: markets.filter((m: MarketGroup) => m.metrics.pricedVaultCount > 0).length,
        vaultCount: markets.reduce((sum: number, m: MarketGroup) => sum + m.metrics.vaultCount, 0),
      }
    })
  })

  /** Find which market group a vault belongs to */
  const getGroupForVault = (vaultAddress: string): MarketGroup | undefined => {
    const normalized = vaultAddress.toLowerCase()
    return marketGroups.value.find((group: MarketGroup) =>
      group.vaults.some((v: AnyVault) => getVaultAddress(v).toLowerCase() === normalized),
    )
  }

  /** Fetch a market group on demand for non-explorable products accessed via direct URL */
  const fetchMarketGroupOnDemand = async (productKey: string): Promise<MarketGroup | null> => {
    const product = products[productKey]
    if (!product) return null

    const allAddresses = [...product.vaults, ...(product.deprecatedVaults || [])]
    if (allAddresses.length === 0) return null

    const memberVaults: Vault[] = []

    try {
      const ctx = buildFetchContext()
      for await (const result of fetchVaults(ctx, allAddresses)) {
        memberVaults.push(...result.vaults)
        if (result.isFinished) break
      }
    }
    catch (e) {
      logWarn('useMarketGroups/fetchMarketGroupOnDemand', e)
    }

    if (memberVaults.length === 0) return null

    const entityKeys = Array.isArray(product.entity) ? product.entity : [product.entity]
    const curatorKey = entityKeys[0] || undefined
    const curator = curatorKey ? entities[curatorKey] : undefined

    const group: MarketGroup = {
      id: productKey,
      name: product.name,
      source: 'product',
      curator,
      curatorKey,
      vaults: memberVaults,
      externalCollateral: [],
      metrics: computeMetricsSync(memberVaults),
    }

    // Augment with collateral graph using registry vaults + fetched vaults
    const registryVaults = getAll().map(entry => entry.vault)
    const [augmented] = augmentWithCollateralGraph([group], [...registryVaults, ...memberVaults])

    try {
      return await resolveGroupTVL(augmented)
    }
    catch (e) {
      logWarn(`useMarketGroups/fetchMarketGroupOnDemand/resolveGroupTVL [${productKey}]`, e)
      return augmented
    }
  }

  return {
    allVaults,
    marketGroups,
    marketGroupsSync,
    curatorGroups,
    isResolvingTVL,
    getGroupForVault,
    fetchMarketGroupOnDemand,
  }
}
