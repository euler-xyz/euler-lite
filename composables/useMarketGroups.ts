import { isEVault, type EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'
import type { MarketGroup, MarketGroupMetrics, CuratorGroup } from '~/entities/lend-discovery'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { isVaultNotExplorable, isVaultRecentlyAdded, isVaultDeprecated, getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import { isLiveCollateralEdge } from '~/utils/vault/ltv'
import { isVaultBorrowable } from '~/utils/vault/classification'
import { liteVaultFetchOptions } from '~/utils/sdk-fetch-options'

// -- Helpers --

const hasGovernorAdmin = (vault: AnyVault): vault is EVault =>
  isEVault(vault) && 'governorAdmin' in vault

const isBorrowableVault = (vault: AnyVault): boolean =>
  isEVault(vault) && isVaultBorrowable(vault)

const getCollateralAddresses = (vault: AnyVault): string[] => {
  if (!isEVault(vault)) return []
  // Skip inactive collateral entries - EVK retains zero-LTV rows for retired
  // or never-activated collaterals, but keep liquidation ramp-down edges
  // visible until their current liquidation LTV reaches zero.
  return vault.collaterals
    .filter(ltv => isLiveCollateralEdge(ltv))
    .map(ltv => ltv.address)
}

const getVaultAddress = (vault: AnyVault): string =>
  isEVault(vault) ? vault.address : ('address' in vault ? (vault as { address: string }).address : '')

const getAssetSymbol = (vault: AnyVault): string => {
  if (isEVault(vault)) return vault.asset.symbol
  if ('asset' in vault && vault.asset && typeof vault.asset === 'object' && 'symbol' in (vault.asset as unknown as Record<string, unknown>)) {
    return (vault.asset as unknown as { symbol: string }).symbol
  }
  return 'Unknown'
}

const getSupplyAPY = (vault: AnyVault): number => {
  if (isEVault(vault)) {
    return getVaultSupplyApy(vault)
  }
  return 0
}

const getBorrowAPY = (vault: AnyVault): number => {
  if (!isEVault(vault)) return 0
  return getVaultBorrowApy(vault)
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
      unknownCollateral: [],
      metrics: computeMetricsSync(memberVaults),
    })
  }

  return { groups, assignedAddresses }
}

// -- Step 2: Augment with Collateral Graph --

const augmentWithCollateralGraph = (
  groups: MarketGroup[],
  allVaults: AnyVault[],
  isVaultGovernorVerified: (vault: EVault) => boolean,
  dataReady: boolean,
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
    const unknownCollateral: string[] = []
    const seenUnknown = new Set<string>()

    for (const vault of group.vaults) {
      const collateralAddrs = getCollateralAddresses(vault)
      for (const colAddr of collateralAddrs) {
        const normalized = colAddr.toLowerCase()
        if (groupAddresses.has(normalized) || seenExternal.has(normalized)) continue
        const externalVault = vaultMap.get(normalized)
        if (externalVault) {
          externalCollateral.push(externalVault)
          seenExternal.add(normalized)
          // Mirror the per-pair "Unknown" risk-manager pill (see
          // VaultBorrowItem). An external collateral whose governor isn't part
          // of any declared product entity is the curator wiring in a vault
          // they don't actually run — surface it in the market graph too so
          // the gap is visible from discovery, not just inside one pair card.
          // Suppress until labels and the vault registry are both ready —
          // otherwise verifiedVaultAddresses is empty / partial and every
          // external briefly looks unknown.
          if (dataReady && hasGovernorAdmin(externalVault) && !isVaultGovernorVerified(externalVault) && !seenUnknown.has(normalized)) {
            seenUnknown.add(normalized)
            unknownCollateral.push(normalized)
          }
        }
        else {
          // The registry hasn't loaded this collateral yet. Labels are loaded
          // upfront and survive lazy registry hydration, so a vault tagged
          // deprecated or assigned to any product is *known* — just not yet
          // fetched (it'll arrive when something like the per-vault page
          // triggers a lazy fetch). Only flag as unknown when no label
          // recognises the address either; otherwise silently drop it so the
          // graph doesn't churn between "unknown placeholder" and "deprecated
          // external" as the registry fills in. Equally, suppress entirely
          // until labels + registry are ready — otherwise truly known-by-
          // label vaults that just haven't been hydrated yet briefly render
          // as `0x...` placeholders for the first second of page load.
          if (!dataReady) continue
          const knownByLabels = isVaultDeprecated(colAddr) || getProductKeyByVault(colAddr) !== undefined
          if (knownByLabels) continue
          if (!seenUnknown.has(normalized)) {
            seenUnknown.add(normalized)
            unknownCollateral.push(normalized)
          }
        }
      }
    }

    return {
      ...group,
      externalCollateral,
      unknownCollateral,
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
    unknownCollateral: [],
    metrics: computeMetricsSync(vaults),
  }))
}

// -- Metrics Computation --

const computeMetricsSync = (vaults: AnyVault[]): MarketGroupMetrics => {
  let bestSupplyAPY = 0
  let bestBorrowAPY = 0
  let borrowableCount = 0
  let totalUtilization = 0
  const assetSymbols = new Set<string>()
  let hasRecentlyAdded = false

  for (const vault of vaults) {
    const supplyAPY = getSupplyAPY(vault)
    if (supplyAPY > bestSupplyAPY) bestSupplyAPY = supplyAPY

    const symbol = getAssetSymbol(vault)
    assetSymbols.add(symbol)

    const addr = getVaultAddress(vault)
    if (addr && isVaultRecentlyAdded(addr)) hasRecentlyAdded = true

    if (isBorrowableVault(vault)) {
      borrowableCount++
      const borrowAPY = getBorrowAPY(vault)
      if (bestBorrowAPY === 0 || (borrowAPY > 0 && borrowAPY < bestBorrowAPY)) {
        bestBorrowAPY = borrowAPY
      }
      if (isEVault(vault)) {
        totalUtilization += vault.utilization
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
    hasRecentlyAdded,
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
      if (borrowable && usdValue > 0 && isEVault(vault)) {
        borrowUsd = await getAssetUsdValueOrZero(vault.totalBorrowed, vault, 'off-chain')
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
  const { products, entities, isReady: labelsReady } = useEulerLabels()
  const { isVaultGovernorVerified, isCollateralResolved, isMarketDataResolved, isReady: vaultsReady } = useVaults()
  const showAllLabelEntries = useShowAllLabelEntries()
  const isReady = computed(() => labelsReady.value && vaultsReady.value && isMarketDataResolved.value)

  /** Every loaded vault, including non-explorable ones (used for collateral lookups) */
  const registryVaults = computed((): AnyVault[] => getAll().map(entry => entry.vault))

  /** All vaults available for grouping */
  const allVaults = computed((): AnyVault[] => {
    return registryVaults.value.filter((vault) => {
      const address = getVaultAddress(vault)
      return address ? showAllLabelEntries.value || !isVaultNotExplorable(address) : true
    })
  })

  /** Synchronous market groups (metrics without TVL) */
  const marketGroupsSync = computed((): MarketGroup[] => {
    // Gate on vaultsReady so the first TVL resolution sees populated
    // marketPriceUsd values. Otherwise hydrateFromServer's atomic
    // registrySetMany triggers a resolve pass before populateMarketPrices
    // has run, every group gets totalTVL=0, and the explore page's
    // "Active" sort falls back to label/discovery order — causing a
    // visible reorder once the second resolve commits real TVLs.
    // Labels feed product grouping/recently-added boosting, and Explore's
    // active sort uses SDK-backed market-price metrics. Wait for both before
    // publishing the first visible group list so it doesn't sort once on
    // placeholder $0 values and again when enrichment restores prices.
    if (!isReady.value) return []
    const vaults = allVaults.value
    if (vaults.length === 0) return []

    // Step 1: Product-label groups
    const { groups: productGroups, assignedAddresses } = buildProductGroups(vaults, products, entities)

    // Step 2: Augment with collateral graph — pass the full registry so active
    // LTVs targeting non-explorable vaults still resolve as externalCollateral
    // instead of triggering a missing-collateral warning. dataReady gates the
    // unknown-collateral classification on labels AND the unresolved-collateral
    // sweep so lazy collateral references that just haven't been fetched yet
    // don't briefly render as `0x...` placeholders. isReady on its own flips
    // after the server snapshot lands — too early, since the snapshot doesn't
    // include lazy collateral references.
    const lookupVaults = registryVaults.value
    const ready = labelsReady.value && isCollateralResolved.value
    const augmented = augmentWithCollateralGraph(productGroups, lookupVaults, isVaultGovernorVerified, ready)

    // Step 3: Orphan clustering
    const orphanGroups = clusterOrphans(vaults, assignedAddresses)
    const augmentedOrphans = augmentWithCollateralGraph(orphanGroups, lookupVaults, isVaultGovernorVerified, ready)

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

    const memberVaults: EVault[] = []

    try {
      const { chainId } = useEulerAddresses()
      const { getEulerSdkForChain } = useEulerSdk()
      // Capture the chain id once so the SDK backend selection and the fetch
      // can't diverge if the user switches chains mid-await.
      const targetChainId = chainId.value
      const sdk = await getEulerSdkForChain(targetChainId)
      const result = await sdk.eVaultService.fetchVaults(
        targetChainId,
        allAddresses.map(addr => getAddress(addr) as Address),
        liteVaultFetchOptions,
      )
      result.errors.forEach(issue => logWarn('useMarketGroups/fetchMarketGroupOnDemand', issue))
      memberVaults.push(...(result.result.filter(Boolean) as EVault[]))
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
      unknownCollateral: [],
      metrics: computeMetricsSync(memberVaults),
    }

    // The direct market page waits for labels and the unresolved-collateral
    // sweep before calling this path. Keep the readiness value explicit here
    // so unknown-collateral classification is still suppressed if this helper
    // is ever called earlier from another route.
    const ready = labelsReady.value && isCollateralResolved.value
    const [augmented] = augmentWithCollateralGraph([group], [...registryVaults.value, ...memberVaults], isVaultGovernorVerified, ready)

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
    isReady,
    isResolvingTVL,
    getGroupForVault,
    fetchMarketGroupOnDemand,
  }
}
