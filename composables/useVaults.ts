import { getAddress } from 'viem'
import { useVaultRegistry } from './useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import {
  type AnyBorrowVaultPair,
  type ChainVaultsSnapshot,
  type EarnVault,
  type SecuritizeVault,
  type SerialisedSnapshot,
  type VerificationLabels,
  deserialiseSnapshot,
  fetchEarnVaults,
  fetchVault,
  fetchEarnVault,
  fetchEscrowVault,
  fetchSecuritizeVault,
  fetchVaults,
  clearPriceCaches,
  extractUnresolvedCollateralAddresses,
  isEarnVaultOwnerVerified as ruleIsEarnVaultOwnerVerified,
  isLiveCollateralEdge,
  isVaultGovernorVerified as ruleIsVaultGovernorVerified,
  type Vault,
} from '~/entities/vault'
import { fetchChainVaultCategories, fetchVaultCategory, isSecuritizeVault, resetVaultCategoryCache } from '~/entities/vault/factory'
import { getProductByVault, isVaultNotExplorable, isEarnVaultNotExplorable } from '~/utils/eulerLabelsUtils'

const isReady = ref(false)
const isEVKLoading = ref(false)
const isEVKUpdating = ref(false)
const loadedChainId = ref<number | null>(null)

const isEarnLoading = ref(false)
const isEarnUpdating = ref(false)

const isSecuritizeLoading = ref(false)
const isSecuritizeUpdating = ref(false)

const isEscrowLoading = ref(false)
const isEscrowUpdating = ref(false)
const isEscrowLoadedOnce = ref(false)

// True once the bulk loaders AND the unresolved-collateral sweep have settled.
// Distinct from `isReady`, which flips as soon as the server snapshot lands —
// the snapshot doesn't include lazy collateral references, so consumers that
// classify "unknown collateral" need this stricter signal to avoid the brief
// post-hydration flash where unfetched collaterals look unrecognised.
const isCollateralResolved = ref(false)

// Generation counter to invalidate stale in-flight operations after chain switch.
// Incremented in resetVaultsState(); any async operation capturing an older generation
// must stop registering vaults.
const loadGeneration = ref(0)

const contextForGeneration = (gen: number) =>
  buildFetchContext(() => loadGeneration.value !== gen)

const showAllLabelEntries = ref(false)

const setShowAllLabelEntries = (enabled: boolean) => {
  showAllLabelEntries.value = enabled
}

// Pair-object cache keyed by `${borrow}:${collateral}`. Vault references in
// the registry are stable across batch updates for vaults NOT in the current
// batch — registrySetMany only replaces entries for the addresses it receives.
// So when `cached.borrow === borrowVault && cached.collateral === collateralVault`,
// every scalar field on the pair is necessarily unchanged (the LTV subfields
// live inside borrowVault.collateralLTVs, which is the same array when the
// borrow vault ref hasn't been replaced). Reusing the cached pair lets
// Vue's shallow prop compare in VaultBorrowItem mark the bound `pair` as
// unchanged for every pair whose vaults weren't in the current batch,
// cutting the row-render cascade down to just the pairs that actually had
// a vault refreshed.
const borrowPairCache = new Map<string, AnyBorrowVaultPair>()

const borrowList = computed((): AnyBorrowVaultPair[] => {
  const { getVerifiedEvkVaults, getVault: registryGetVault } = useVaultRegistry()
  const pairs: AnyBorrowVaultPair[] = []
  const evkVaults = getVerifiedEvkVaults(showAllLabelEntries.value)
  const seenKeys = new Set<string>()

  evkVaults.forEach((borrowVault) => {
    borrowVault.collateralLTVs.forEach((ltv) => {
      if (ltv.borrowLTV <= 0n) return

      const collateralVault = registryGetVault(ltv.collateral)
      if (!collateralVault) return
      if (!showAllLabelEntries.value && isVaultNotExplorable(collateralVault.address)) return

      const key = `${borrowVault.address.toLowerCase()}:${ltv.collateral.toLowerCase()}`
      seenKeys.add(key)

      const cached = borrowPairCache.get(key)
      if (cached && cached.borrow === borrowVault && cached.collateral === collateralVault) {
        pairs.push(cached)
        return
      }

      const pair = {
        borrow: borrowVault,
        collateral: collateralVault,
        borrowLTV: ltv.borrowLTV,
        liquidationLTV: ltv.liquidationLTV,
        initialLiquidationLTV: ltv.initialLiquidationLTV,
        targetTimestamp: ltv.targetTimestamp,
        rampDuration: ltv.rampDuration,
      } as AnyBorrowVaultPair
      borrowPairCache.set(key, pair)
      pairs.push(pair)
    })
  })

  // Garbage-collect entries that aren't in the current pair set (chain switch,
  // vault removed from perspective). Keeps the cache bounded.
  for (const key of borrowPairCache.keys()) {
    if (!seenKeys.has(key)) borrowPairCache.delete(key)
  }

  return pairs
})

const resetVaultsState = () => {
  const { clear } = useVaultRegistry()

  loadGeneration.value++
  borrowPairCache.clear()
  isReady.value = false
  isCollateralResolved.value = false
  isEVKLoading.value = true
  isEVKUpdating.value = true
  isEarnLoading.value = true
  isEarnUpdating.value = true
  isSecuritizeLoading.value = true
  isSecuritizeUpdating.value = true
  isEscrowUpdating.value = true
  isEscrowLoadedOnce.value = false
  loadedChainId.value = null
  clear()
  clearPriceCaches()
  resetVaultCategoryCache()
}

const updateEVKVaults = async (vaultAddresses: string[], generation?: number, silent = false) => {
  const { setMany: registrySetMany, getVault: registryGetVault } = useVaultRegistry()
  const gen = generation ?? loadGeneration.value
  const ctx = contextForGeneration(gen)

  try {
    if (!silent) {
      isEVKUpdating.value = true
      isEVKLoading.value = true
    }

    for await (const result of fetchVaults(ctx, vaultAddresses)) {
      if (loadGeneration.value !== gen) return

      registrySetMany(result.vaults.map((vault) => {
        const existing = registryGetVault(vault.address) as Vault | undefined
        const vaultCategory = existing?.vaultCategory
        const verified = vaultCategory === 'escrow' ? true : vault.verified
        return {
          address: vault.address,
          vault: vaultCategory ? { ...vault, vaultCategory, verified } : vault,
          type: 'evk' as const,
        }
      }))

      if (!silent) {
        isEVKLoading.value = false
      }

      if (result.isFinished) {
        break
      }
    }
  }
  catch (e) {
    logWarn('useVaults/updateEVKVaults', e)
  }
  finally {
    if (!silent && loadGeneration.value === gen) {
      isEVKUpdating.value = false
    }
  }
}
const updateEarnVaults = async (vaultAddresses: string[], generation?: number, silent = false) => {
  const { setMany: registrySetMany } = useVaultRegistry()
  const gen = generation ?? loadGeneration.value
  const ctx = contextForGeneration(gen)

  try {
    if (!silent) {
      isEarnUpdating.value = true
      isEarnLoading.value = true
    }

    for await (const result of fetchEarnVaults(ctx, vaultAddresses)) {
      if (loadGeneration.value !== gen) return

      registrySetMany(result.vaults.map(vault => ({
        address: vault.address,
        vault,
        type: 'earn' as const,
      })))

      if (!silent) {
        isEarnLoading.value = false
      }

      if (result.isFinished) {
        break
      }
    }
  }
  catch (e) {
    logWarn('useVaults/updateEarnVaults', e)
    if (!silent && loadGeneration.value === gen) {
      isEarnUpdating.value = false
    }
  }
  // Note: isEarnUpdating is set to false in loadVaults() after all vaults are loaded
}

/**
 * Extract escrow vault addresses that are needed (used as collateral in EVK vaults
 * or as strategies in Earn vaults).
 */
const extractNeededEscrowAddresses = (): string[] => {
  const { getEvkVaults, getEarnVaults, isKnownEscrowAddress } = useVaultRegistry()
  const needed = new Set<string>()

  // 1. Escrow vaults used as collateral in EVK vaults — include any live edge,
  //    not just borrowable ones, so escrows mid-liquidation-LTV-ramp (where
  //    borrowLTV is already 0) still get fetched and shown in discovery.
  getEvkVaults().forEach((vault) => {
    vault.collateralLTVs.forEach((ltv) => {
      if (isLiveCollateralEdge(ltv) && isKnownEscrowAddress(ltv.collateral)) {
        needed.add(getAddress(ltv.collateral))
      }
    })
  })

  // 2. Escrow vaults used as strategies in Earn vaults
  getEarnVaults().forEach((earnVault) => {
    earnVault.strategies.forEach((strategyInfo) => {
      if (isKnownEscrowAddress(strategyInfo.strategy)) {
        needed.add(getAddress(strategyInfo.strategy))
      }
    })
  })

  return [...needed]
}

/**
 * Fetch vault info only for the specified escrow addresses.
 * Used for lazy loading - only fetch info for escrow vaults actually used as collateral.
 */
const fetchNeededEscrowVaults = async (addresses: string[], generation: number): Promise<void> => {
  const { setMany: registrySetMany } = useVaultRegistry()

  if (!addresses.length || loadGeneration.value !== generation) {
    return
  }

  const ctx = contextForGeneration(generation)
  const results = await Promise.allSettled(
    addresses.map(addr => fetchEscrowVault(addr, ctx)),
  )

  if (loadGeneration.value !== generation) return

  const entries: Array<{ address: string, vault: Vault, type: 'evk' }> = []
  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      entries.push({ address: result.value.address, vault: result.value, type: 'evk' })
    }
    else {
      logWarn('useVaults/escrow', result.reason)
    }
  })
  registrySetMany(entries)
}

/**
 * Lazy-resolve collateral addresses that aren't covered by the bulk loaders.
 *
 * `fetchChainVaultCategories` already ran earlier in this `loadVaults` call
 * and populated the per-address category cache, so `fetchVaultCategory` is a
 * cache hit for every address indexed by the subgraph. We group addresses
 * by category and hand each group to the existing bulk loader for that type
 * (`updateEVKVaults` / `updateEarnVaults` / `updateSecuritizeVaults` /
 * `fetchNeededEscrowVaults`) — same multicall batching, same registry-write
 * path, no parallel implementation. `silent=true` keeps loading flags
 * untouched since this runs after the initial reveal.
 *
 * Addresses the subgraph has not indexed (category === null) are skipped —
 * a probe-and-guess fallback would misidentify brand-new escrows as plain
 * EVK, and the next `loadVaults` cycle picks them up once the subgraph
 * catches up. The diagnostic warns in `useMarketGroups` and
 * `VaultOverviewBlockBorrow` surface the gap in the meantime.
 */
const fetchUnresolvedCollaterals = async (addresses: string[], generation: number): Promise<void> => {
  if (!addresses.length || loadGeneration.value !== generation) return

  const evkAddrs: string[] = []
  const earnAddrs: string[] = []
  const securitizeAddrs: string[] = []
  const escrowAddrs: string[] = []

  await Promise.allSettled(addresses.map(async (addr) => {
    const category = await fetchVaultCategory(addr)
    switch (category) {
      case 'escrow':
        escrowAddrs.push(addr)
        break
      case 'evk':
        evkAddrs.push(addr)
        break
      case 'earn':
        earnAddrs.push(addr)
        break
      case 'securitize':
        securitizeAddrs.push(addr)
        break
      default:
        // Subgraph hasn't indexed this address — skip and let the next
        // loadVaults cycle pick it up once the category endpoint warms.
        break
    }
  }))

  if (loadGeneration.value !== generation) return

  // Bulk loaders short-circuit on empty input, so call unconditionally.
  await Promise.all([
    updateEVKVaults(evkAddrs, generation, true),
    updateEarnVaults(earnAddrs, generation, true),
    updateSecuritizeVaults(securitizeAddrs, generation, true),
    fetchNeededEscrowVaults(escrowAddrs, generation),
  ])
}

const resolveUnresolvedCollaterals = async (generation: number): Promise<void> => {
  const { getEvkVaults, has: registryHas } = useVaultRegistry()
  const unresolvedAddresses = extractUnresolvedCollateralAddresses(
    getEvkVaults(),
    registryHas,
  ).filter(addr => showAllLabelEntries.value || !isVaultNotExplorable(addr))

  await fetchUnresolvedCollaterals(unresolvedAddresses, generation)
}

const updateSecuritizeVaults = async (securitizeAddresses: string[], generation: number, silent = false) => {
  const { setMany: registrySetMany } = useVaultRegistry()

  if (!securitizeAddresses.length || loadGeneration.value !== generation) {
    return
  }

  try {
    if (!silent) {
      isSecuritizeUpdating.value = true
      isSecuritizeLoading.value = true
    }

    const ctx = contextForGeneration(generation)
    const results = await Promise.allSettled(
      securitizeAddresses.map(addr => fetchSecuritizeVault(addr, ctx)),
    )

    if (loadGeneration.value !== generation) return

    const entries: Array<{ address: string, vault: SecuritizeVault, type: 'securitize' }> = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        entries.push({ address: result.value.address, vault: result.value, type: 'securitize' })
      }
      else {
        logWarn(`useVaults/updateSecuritizeVaults/${securitizeAddresses[index]}`, result.reason)
      }
    })
    registrySetMany(entries)
  }
  catch (e) {
    logWarn('useVaults/updateSecuritizeVaults', e)
  }
  finally {
    if (!silent && loadGeneration.value === generation) {
      isSecuritizeUpdating.value = false
      isSecuritizeLoading.value = false
    }
  }
}

/**
 * Hydrate the registry from the server-side snapshot endpoint.
 *
 * Returns true if hydration succeeded, false if the server endpoint failed
 * or was stale — the caller falls through to the full RPC pipeline in that
 * case. On success, isReady is flipped immediately so UI consumers unblock
 * without waiting on the full RPC refresh.
 *
 * Loading flags (isEVKLoading etc.) clear on hydration success because we
 * have valid data to render; updating flags (isEVKUpdating) stay true so the
 * subsequent RPC refresh can still signal "refresh in progress" to the UI.
 */
/** Upper bound on snapshot age the client will hydrate from. Covers normal
 * warm-cache intervals (4 min) plus a couple of missed cycles. Older
 * snapshots are discarded and the RPC pipeline populates from scratch. */
const MAX_HYDRATION_AGE_MS = 15 * 60_000

/** Narrow the opaque wire object to the ChainVaultsSnapshot shape before we
 * start trusting it for registry writes. A malformed server response would
 * otherwise crash at the first `.map()` call. */
const isChainVaultsSnapshot = (v: unknown): v is ChainVaultsSnapshot => {
  if (v === null || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.chainId === 'number'
    && typeof s.fetchedAt === 'number'
    && Array.isArray(s.evkVaults)
    && Array.isArray(s.earnVaults)
    && Array.isArray(s.securitizeVaults)
    && Array.isArray(s.escrowVaults)
}

const hydrateFromServer = async (targetChainId: number, generation: number): Promise<boolean> => {
  const { setMany: registrySetMany, setEscrowAddresses } = useVaultRegistry()
  try {
    // Snapshot + categorization fetched in parallel. Both are warm-cached
    // server-side so this is usually two fast hits. Categorization provides
    // the escrow address set previously baked into the snapshot payload.
    const [wire, categories] = await Promise.all([
      $fetch<SerialisedSnapshot>('/api/vaults', { query: { chainId: targetChainId } }),
      fetchChainVaultCategories(),
    ])
    if (loadGeneration.value !== generation) return false

    const snap = deserialiseSnapshot(wire)
    if (!isChainVaultsSnapshot(snap)) {
      logWarn('useVaults/hydrateFromServer', 'server returned a malformed snapshot; falling back to RPC')
      return false
    }
    if (snap.chainId !== targetChainId) return false
    if (Date.now() - snap.fetchedAt > MAX_HYDRATION_AGE_MS) {
      // Snapshot is older than MAX_HYDRATION_AGE_MS — indicates prolonged
      // warm-cache failure. Reject rather than render stale prices/caps.
      logWarn('useVaults/hydrateFromServer', `snapshot too stale (${Math.round((Date.now() - snap.fetchedAt) / 1000)}s old); falling back to RPC`)
      return false
    }

    // Registry writes: match the type tags useVaults normally uses so that
    // getType/getVault/isEscrowVault all work identically after hydration.
    // Re-stamp vaultCategory='escrow' defensively on escrow vaults — the
    // loader already sets it via fetchEscrowVault, but the registry write
    // is our last chance to guarantee it for downstream `vaultCategory`
    // consumers (VaultItem etc.).
    registrySetMany(snap.evkVaults.map(vault => ({ address: vault.address, vault, type: 'evk' as const })))
    registrySetMany(snap.escrowVaults.map(vault => ({
      address: vault.address,
      vault: { ...vault, vaultCategory: 'escrow' as const },
      type: 'evk' as const,
    })))
    registrySetMany(snap.earnVaults.map(vault => ({ address: vault.address, vault, type: 'earn' as const })))
    registrySetMany(snap.securitizeVaults.map(vault => ({ address: vault.address, vault, type: 'securitize' as const })))
    // Seed escrow set from the categorization. UI routing (isKnownEscrowAddress)
    // depends on this being populated at hydration time.
    setEscrowAddresses(categories.escrow)

    // Clear both loading AND updating flags: the registry is fully populated
    // from the snapshot, and the subsequent RPC refresh runs in silent mode
    // so it won't re-toggle them. Consumers gating on isEVKUpdating
    // (e.g. pages/lend) unblock immediately instead of waiting on the full
    // RPC refresh.
    isEVKLoading.value = false
    isEVKUpdating.value = false
    isEarnLoading.value = false
    isEarnUpdating.value = false
    isSecuritizeLoading.value = false
    isSecuritizeUpdating.value = false
    isEscrowLoading.value = false
    isEscrowUpdating.value = false
    isEscrowLoadedOnce.value = true
    isReady.value = true
    loadedChainId.value = targetChainId

    return true
  }
  catch (err) {
    logWarn('useVaults/hydrateFromServer', err)
    return false
  }
}

const loadVaults = async () => {
  const { chainId } = useEulerAddresses()
  const { verifiedVaultAddresses, earnVaults: earnVaultAddresses } = useEulerLabels()
  const { setEscrowAddresses } = useVaultRegistry()

  resetVaultsState()
  const generation = loadGeneration.value
  const startChainId = chainId.value

  // Hydrate from server cache first. On failure we fall through and the
  // RPC pipeline below populates from scratch.
  const hydrated = await hydrateFromServer(startChainId, generation)
  if (loadGeneration.value !== generation) return

  // When hydrated, the RPC refresh below runs in *silent* mode: the UI
  // already has valid data to render, so per-category loading/updating
  // flags stay false (same semantics as the 60s polling refresh). Pages
  // that gate content on isEVKUpdating / isEarnUpdating / etc unblock
  // immediately. When hydration failed, the refresh runs non-silent so
  // flags drive the loading state normally.
  const silent = hydrated

  // Filter out non-explorable vaults before any on-chain work
  const explorableVaultAddresses = showAllLabelEntries.value
    ? verifiedVaultAddresses.value
    : verifiedVaultAddresses.value.filter(addr => !isVaultNotExplorable(addr))
  const explorableEarnAddresses = showAllLabelEntries.value
    ? earnVaultAddresses.value
    : earnVaultAddresses.value.filter(addr => !isEarnVaultNotExplorable(addr))

  try {
    if (!silent) {
      isEscrowUpdating.value = true
      isEscrowLoading.value = true
    }

    // Phase 1: Fetch chain-wide vault categorization. The endpoint is
    // CDN-cacheable and warm-cached server-side, so this is usually a
    // ~50ms fetch. Addresses missing from the categorization (new
    // deployments the subgraph hasn't indexed yet) default to EVK —
    // the VaultLens handles any ERC-4626 + EVK-compatible vault.
    const categories = await fetchChainVaultCategories()

    if (loadGeneration.value !== generation) return

    const securitizeSet = new Set(categories.securitize.map(a => a.toLowerCase()))
    const evkAddresses: string[] = []
    const securitizeAddresses: string[] = []

    explorableVaultAddresses.forEach((addr) => {
      if (securitizeSet.has(addr.toLowerCase())) {
        securitizeAddresses.push(addr)
      }
      else {
        evkAddresses.push(addr)
      }
    })

    // Seed the registry's escrow set from the categorization. The catalog
    // endpoint already reads EscrowedCollateralPerspective.verifiedArray()
    // server-side, so no redundant client-side RPC call is needed.
    setEscrowAddresses(categories.escrow)

    // Phase 2: fetch EVK, Earn, Securitize in parallel; follow with escrow
    // vault info once EVK collateralLTVs + Earn strategies are known (the
    // escrow subset referenced by them is what we need to fetch details for).

    let evkResolve: () => void = () => {}
    let earnResolve: () => void = () => {}
    const evkLoaded = new Promise<void>((resolve) => {
      evkResolve = resolve
    })
    const earnLoaded = new Promise<void>((resolve) => {
      earnResolve = resolve
    })

    await Promise.all([
      (async () => {
        await updateEarnVaults(explorableEarnAddresses, generation, silent)
        earnResolve()
      })(),
      (async () => {
        await updateEVKVaults(evkAddresses, generation, silent)
        evkResolve()
      })(),
      updateSecuritizeVaults(securitizeAddresses, generation, silent),
      Promise.all([evkLoaded, earnLoaded]).then(async () => {
        const neededEscrowAddresses = extractNeededEscrowAddresses()
        await fetchNeededEscrowVaults(neededEscrowAddresses, generation)
      }),
    ])

    if (loadGeneration.value !== generation) return

    // After bulk loaders + escrow lazy-fetch settle, sweep up any collateral
    // address referenced by a member vault that isn't yet in the registry.
    // These are typically EVK vaults that exist on chain but aren't part of
    // any product label — without this, discovery views silently drop the
    // relationship. Single pass is enough: discovery views iterate only
    // member vaults, so a resolved off-label vault is a leaf in those views;
    // any second-hop unknowns will surface as diagnostic warns and resolve
    // on the next loadVaults cycle.
    await resolveUnresolvedCollaterals(generation)

    if (loadGeneration.value !== generation) return

    // Bulk loaders + unresolved-collateral sweep are complete. Consumers
    // gating "unknown collateral" classification can now run without
    // misclassifying not-yet-hydrated lazy collateral references.
    isCollateralResolved.value = true

    // Clear flags AFTER all needed escrow vaults are loaded.
    // Silent mode skips EVK/Earn flags (already false from hydration) but
    // still clears escrow + securitize which were never touched during
    // the silent RPC refresh.
    if (!silent) {
      isEarnUpdating.value = false
      isSecuritizeUpdating.value = false
      isSecuritizeLoading.value = false
      isEscrowUpdating.value = false
      isEscrowLoading.value = false
    }
    isEscrowLoadedOnce.value = true
  }
  catch (e) {
    logWarn('useVaults/loadVaults', e)
    if (loadGeneration.value === generation) {
      // A failed load means no collateral-resolution task is still in flight.
      // Unblock consumers so direct market pages can render their fallback
      // state instead of waiting forever on a failed sweep.
      isCollateralResolved.value = true
      isEVKLoading.value = false
      isEVKUpdating.value = false
      isEarnLoading.value = false
      isEarnUpdating.value = false
      isSecuritizeLoading.value = false
      isSecuritizeUpdating.value = false
      isEscrowLoading.value = false
      isEscrowUpdating.value = false
    }
  }
  finally {
    if (loadGeneration.value === generation && chainId.value === startChainId) {
      isReady.value = true
      loadedChainId.value = startChainId
    }
  }
}
const getVault = async (address: string): Promise<Vault> => {
  const { verifiedVaultAddresses } = useEulerLabels()
  const {
    getType,
    getVault: registryGetVault,
    has: registryHas,
    getOrFetch: registryGetOrFetch,
  } = useVaultRegistry()
  const normalizedAddress = getAddress(address)

  // Check if this is a securitize vault - if so, throw to trigger fallback
  const vaultType = getType(normalizedAddress)
  if (vaultType === 'securitize') {
    throw new Error('[getVault] Address is a securitize vault, use getSecuritizeVault instead')
  }

  // If vault is already in registry as EVK, return it directly
  // This prevents overwriting escrow vaults (which have verified: true) with fetchVault results
  if (vaultType === 'evk') {
    return registryGetVault(normalizedAddress) as Vault
  }

  // If still no type info and address is in verifiedVaultAddresses but not in registry,
  // do an async check to avoid infinite wait on securitize vaults
  if (
    !vaultType
    && verifiedVaultAddresses.value.includes(normalizedAddress)
    && !registryHas(normalizedAddress)
  ) {
    const isSecuritize = await isSecuritizeVault(normalizedAddress)
    if (isSecuritize) {
      throw new Error('[getVault] Address is a securitize vault, use getSecuritizeVault instead')
    }
  }

  if (verifiedVaultAddresses.value.includes(normalizedAddress) && !isVaultNotExplorable(normalizedAddress)) {
    await until(computed(() => registryGetVault(normalizedAddress))).toBeTruthy()
    return registryGetVault(normalizedAddress) as Vault
  }

  // Unlabeled address — route through the registry's resolveUnknown path so
  // we correctly detect escrow / securitize via subgraph factory lookup +
  // escrow perspective check, instead of blindly calling the EVK lens.
  // getOrFetch caches the result in the registry with the correct type tag.
  await registryGetOrFetch(normalizedAddress)
  const resolvedType = getType(normalizedAddress)
  if (resolvedType === 'securitize') {
    throw new Error('[getVault] Address is a securitize vault, use getSecuritizeVault instead')
  }
  if (resolvedType === 'earn') {
    throw new Error('[getVault] Address is an earn vault, use getEarnVault instead')
  }
  return registryGetVault(normalizedAddress) as Vault
}
const getEarnVault = async (address: string): Promise<EarnVault> => {
  const { getVault: registryGetVault, set: registrySet } = useVaultRegistry()
  const normalizedAddress = getAddress(address)
  const { earnVaults } = useEulerLabels()

  if (earnVaults.value.includes(normalizedAddress) && !isEarnVaultNotExplorable(normalizedAddress)) {
    await until(computed(() => registryGetVault(normalizedAddress))).toBeTruthy()
  }
  else {
    const vault = await fetchEarnVault(normalizedAddress, contextForGeneration(loadGeneration.value))
    registrySet(normalizedAddress, vault, 'earn')
    return vault
  }

  return registryGetVault(normalizedAddress) as EarnVault
}
const updateVault = async (vaultAddress: string): Promise<Vault | SecuritizeVault> => {
  const { set: registrySet, isKnownEscrowAddress, getType } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const ctx = contextForGeneration(loadGeneration.value)

  // Use appropriate fetch function based on vault type
  if (getType(address) === 'securitize') {
    const vault = await fetchSecuritizeVault(address, ctx)
    registrySet(address, vault, 'securitize')
    return vault
  }

  const vault = isKnownEscrowAddress(address)
    ? await fetchEscrowVault(address, ctx)
    : await fetchVault(address, ctx)

  registrySet(address, vault, 'evk')
  return vault
}
/**
 * Silent vault data refresh — updates registry in-place without resetting loading flags.
 * Used for periodic polling to keep interest rates, supply/borrow totals, and prices fresh.
 */
const refreshVaults = async () => {
  const { getEvkVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
  const gen = loadGeneration.value

  try {
    await updateEVKVaults(getEvkVaults().map(v => v.address), gen, true)
    if (loadGeneration.value !== gen) return

    await resolveUnresolvedCollaterals(gen)
    if (loadGeneration.value !== gen) return
  }
  catch (e) {
    logWarn('useVaults/refreshVaults', e)
  }
  finally {
    if (loadGeneration.value === gen) {
      isCollateralResolved.value = true
    }
  }

  if (loadGeneration.value !== gen) return

  await updateEarnVaults(getEarnVaults().map(v => v.address), gen, true)
  if (loadGeneration.value !== gen) return

  await updateSecuritizeVaults(getSecuritizeVaults().map(v => v.address), gen, true)
}

const updateEarnVault = async (vaultAddress: string): Promise<EarnVault> => {
  const { set: registrySet } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const vault = await fetchEarnVault(address, contextForGeneration(loadGeneration.value))
  registrySet(address, vault, 'earn')
  return vault
}

const getEscrowVault = async (address: string): Promise<Vault> => {
  const { getVault: registryGetVault, isEscrowVault: registryIsEscrow, isKnownEscrowAddress, set: registrySet } = useVaultRegistry()
  const normalizedAddress = getAddress(address)

  // Wait for escrow loading to complete (address set populated, needed vaults loaded)
  if (!isEscrowLoadedOnce.value) {
    await until(isEscrowLoadedOnce).toBe(true)
  }

  // Check if already in registry with full vault info
  const existingVault = registryGetVault(normalizedAddress)
  if (existingVault && registryIsEscrow(normalizedAddress)) {
    return existingVault as Vault
  }

  const ctx = contextForGeneration(loadGeneration.value)

  // If it's a known escrow address but not in registry (wasn't needed during initial load),
  // fetch on-demand
  if (isKnownEscrowAddress(normalizedAddress)) {
    const vault = await fetchEscrowVault(normalizedAddress, ctx)
    registrySet(normalizedAddress, vault, 'evk')
    return vault
  }

  // Last resort: try fetching anyway (might be an escrow vault not in perspective yet)
  const vault = await fetchEscrowVault(normalizedAddress, ctx)
  registrySet(normalizedAddress, vault, 'evk')
  return vault
}

const updateEscrowVault = async (vaultAddress: string): Promise<Vault> => {
  const { set: registrySet } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const vault = await fetchEscrowVault(address, contextForGeneration(loadGeneration.value))
  registrySet(address, vault, 'evk')
  return vault
}

const getSecuritizeVault = async (address: string): Promise<SecuritizeVault> => {
  const normalizedAddress = getAddress(address)
  const { getVault: registryGetVault, getType, set: registrySet } = useVaultRegistry()

  if (getType(normalizedAddress) === 'securitize') {
    return registryGetVault(normalizedAddress) as SecuritizeVault
  }

  const vault = await fetchSecuritizeVault(normalizedAddress, contextForGeneration(loadGeneration.value))
  registrySet(normalizedAddress, vault, 'securitize')
  return vault
}

const getBorrowVaultPair = async (
  collateralAddress: string,
  borrowAddress: string,
): Promise<AnyBorrowVaultPair> => {
  const {
    getVault: registryGetVault,
    getType,
    isEscrowVault: registryIsEscrow,
    set: registrySet,
  } = useVaultRegistry()
  const collateralAddr = getAddress(collateralAddress)
  const borrowAddr = getAddress(borrowAddress)

  // Wait for escrow vaults to load before checking registry
  if (!isEscrowLoadedOnce.value) {
    await until(isEscrowLoadedOnce).toBe(true)
  }

  const borrowType = getType(borrowAddr)
  if (borrowType === 'evk') {
    const borrowVault = registryGetVault(borrowAddr) as Vault
    const collateralType = getType(collateralAddr)

    if (collateralType === 'evk' || collateralType === 'securitize') {
      const collateralVault = registryGetVault(collateralAddr)!
      const ltv = borrowVault.collateralLTVs.find(c => c.collateral === collateralAddr)

      if (!ltv) {
        const vaultTypeLabel = collateralType === 'securitize' ? 'securitize vault' : (registryIsEscrow(collateralAddr) ? 'escrow vault' : 'vault')
        throw `[getBorrowVaultPair]: Collateral LTV not found for ${vaultTypeLabel}`
      }

      return {
        borrow: borrowVault,
        collateral: collateralVault,
        borrowLTV: ltv.borrowLTV,
        liquidationLTV: ltv.liquidationLTV,
        initialLiquidationLTV: ltv.initialLiquidationLTV,
        targetTimestamp: ltv.targetTimestamp,
        rampDuration: ltv.rampDuration,
      } as AnyBorrowVaultPair
    }
  }

  const ctx = contextForGeneration(loadGeneration.value)

  // Fallback: fetch borrow vault if not in registry
  const borrowVault = await fetchVault(borrowAddr, ctx)
  if (!borrowVault) {
    throw '[getBorrowVaultPair]: Borrow vault not found'
  }
  registrySet(borrowAddr, borrowVault, 'evk')

  const collateralLTV = borrowVault.collateralLTVs.find(c => c.collateral === collateralAddr)
  if (!collateralLTV) {
    throw '[getBorrowVaultPair]: Collateral not configured for this borrow vault'
  }

  // Check collateral type from registry
  const collateralType = getType(collateralAddr)
  let collateralVault: Vault | SecuritizeVault | undefined

  if (registryIsEscrow(collateralAddr)) {
    collateralVault = await getEscrowVault(collateralAddr)
  }
  else if (collateralType === 'securitize') {
    collateralVault = registryGetVault(collateralAddr) as SecuritizeVault
  }
  else {
    try {
      collateralVault = await fetchVault(collateralAddr, ctx)
      registrySet(collateralAddr, collateralVault, 'evk')
    }
    catch {
      // Try escrow vault first
      try {
        collateralVault = await fetchEscrowVault(collateralAddr, ctx)
        registrySet(collateralAddr, collateralVault, 'evk')
      }
      catch {
        // Check if it's a securitize vault
        const isSecuritize = await isSecuritizeVault(collateralAddr)
        if (isSecuritize) {
          collateralVault = await fetchSecuritizeVault(collateralAddr, ctx)
          // Add to registry so balances can be fetched
          registrySet(collateralAddr, collateralVault, 'securitize')
        }
        else {
          throw '[getBorrowVaultPair]: Failed to fetch collateral vault'
        }
      }
    }
  }

  // Fire the off-label sweep so the freshly registered borrow / collateral
  // vault's own collateralLTVs[] get resolved into the registry — without
  // this, deep-linked unverified pairs render with empty Collateral exposure
  // blocks because referenced vaults were never loaded by the bulk pipeline.
  // Fire-and-forget: the pair render shouldn't wait on additional lens reads,
  // and resolveUnresolvedCollaterals updates the reactive registry as it goes.
  void resolveUnresolvedCollaterals(loadGeneration.value)

  return {
    borrow: borrowVault,
    collateral: collateralVault,
    borrowLTV: collateralLTV.borrowLTV,
    liquidationLTV: collateralLTV.liquidationLTV,
    initialLiquidationLTV: collateralLTV.initialLiquidationLTV,
    targetTimestamp: collateralLTV.targetTimestamp,
    rampDuration: collateralLTV.rampDuration,
  } as AnyBorrowVaultPair
}

export const useVaults = () => {
  // Build the shared `VerificationLabels` shape once per useVaults() call.
  // The closures read live from the reactive labels store, so the rule
  // always sees current entities/products without rebuilding the shape on
  // every call. Both isVaultGovernorVerified and isEarnVaultOwnerVerified
  // delegate to entities/vault/governor-verification.ts.
  const { entities } = useEulerLabels()
  const verificationLabels: VerificationLabels = {
    getDeclaredEntityKeys: (addr) => {
      const product = getProductByVault(addr)
      if (!product.name) return undefined
      return Array.isArray(product.entity) ? product.entity : [product.entity].filter(Boolean)
    },
    hasEntityAddress: (key, address) => {
      // Static type says addresses is non-null, but the label data flows
      // through JSON from an external repo — a malformed entity entry can
      // arrive without an `addresses` map, in which case `in` would throw
      // and a single bad entry would break verification for every vault.
      const entity = entities[key]
      return !!entity?.addresses && address in entity.addresses
    },
  }

  const isVaultGovernorVerified = (vault: Vault | SecuritizeVault): boolean =>
    ruleIsVaultGovernorVerified(vault, verificationLabels)

  const isEarnVaultOwnerVerified = (earnVault: EarnVault): boolean =>
    ruleIsEarnVaultOwnerVerified(earnVault, verificationLabels)

  return {
    // State
    isReady,
    isCollateralResolved,
    loadedChainId,
    isEVKLoading,
    isEVKUpdating,
    isEarnLoading,
    isEarnUpdating,
    isSecuritizeLoading,
    isSecuritizeUpdating,
    isEscrowLoading,
    isEscrowUpdating,
    isEscrowLoadedOnce,

    // Loading
    loadVaults,
    resetVaultsState,
    setShowAllLabelEntries,

    // Async getters (with wait-for-load logic)
    getVault,
    getEarnVault,
    getEscrowVault,
    getSecuritizeVault,
    getBorrowVaultPair,

    // Update single vault
    updateVault,
    updateEarnVault,
    updateEscrowVault,
    refreshVaults,

    // Bulk updates (internal use)
    updateEVKVaults,
    updateEarnVaults,

    // Verification
    isSecuritizeVault,
    isVaultGovernorVerified,
    isEarnVaultOwnerVerified,

    // Business logic computed (kept for complex queries)
    borrowList,
  }
}
