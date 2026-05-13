import type { EulerEarn, SecuritizeCollateralVault, EVault } from '@eulerxyz/euler-v2-sdk'
import { extractUnresolvedCollateralAddresses } from '~/utils/vault/collateral-discovery'
import { isLiveCollateralEdge } from '~/utils/vault/ltv'
import { fetchChainVaultCategories, fetchVaultCategory, isSecuritizeVault, resetVaultCategoryCache } from '~/utils/vault/categories'
import { getProductByVault, isVaultNotExplorable, isEarnVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAddress, type Address } from 'viem'
import { useVaultRegistry } from './useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'

const isReady = ref(false)
const isEVaultLoading = ref(false)
const isEVaultUpdating = ref(false)
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

const sdkVaultFetchOptions = {
  populateMarketPrices: true,
  populateCollaterals: true,
  populateStrategyVaults: true,
  populateRewards: true,
  eVaultFetchOptions: {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateRewards: true,
  },
}

interface UpdateEVaultsOptions {
  verifiedAddresses?: ReadonlySet<string>
}

const getSdkVaults = async () => {
  const { getEulerSdk } = useEulerSdk()
  return await getEulerSdk()
}

const showAllLabelEntries = ref(false)

const setShowAllLabelEntries = (enabled: boolean) => {
  showAllLabelEntries.value = enabled
}

// Pair-object cache keyed by `${borrow}:${collateral}`. Vault references in
// the registry are stable across batch updates for vaults NOT in the current
// batch — registrySetMany only replaces entries for the addresses it receives.
// So when `cached.borrow === borrowVault && cached.collateral === collateralVault`,
// `cached.ltv` also points at the same SDK collateral edge inside
// borrowVault.collaterals. Reusing the cached pair lets
// Vue's shallow prop compare in VaultBorrowItem mark the bound `pair` as
// unchanged for every pair whose vaults weren't in the current batch,
// cutting the row-render cascade down to just the pairs that actually had
// a vault refreshed.
const borrowPairCache = new Map<string, AnyBorrowVaultPair>()

const borrowList = computed((): AnyBorrowVaultPair[] => {
  const { getVerifiedEVaults, getVault: registryGetVault } = useVaultRegistry()
  const { verifiedVaultAddresses } = useEulerLabels()
  const pairs: AnyBorrowVaultPair[] = []
  const vaultOrder = new Map(
    verifiedVaultAddresses.value.map((address, index) => [address.toLowerCase(), index]),
  )
  const getVaultOrder = (address: string) => vaultOrder.get(address.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
  const eVaults = [...getVerifiedEVaults(showAllLabelEntries.value)]
    .sort((a, b) => getVaultOrder(a.address) - getVaultOrder(b.address))
  const seenKeys = new Set<string>()

  eVaults.forEach((borrowVault) => {
    const collaterals = [...borrowVault.collaterals]
      .sort((a, b) => getVaultOrder(a.address) - getVaultOrder(b.address))

    collaterals.forEach((ltv) => {
      if (ltv.borrowLTV <= 0) return

      const collateralVault = registryGetVault(ltv.address)
      if (!collateralVault) return
      if (!showAllLabelEntries.value && isVaultNotExplorable(collateralVault.address)) return

      const key = `${borrowVault.address.toLowerCase()}:${ltv.address.toLowerCase()}`
      seenKeys.add(key)

      const cached = borrowPairCache.get(key)
      if (cached && cached.borrow === borrowVault && cached.collateral === collateralVault) {
        pairs.push(cached)
        return
      }

      const pair = {
        borrow: borrowVault,
        collateral: collateralVault,
        ltv,
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
  isEVaultLoading.value = true
  isEVaultUpdating.value = true
  isEarnLoading.value = true
  isEarnUpdating.value = true
  isSecuritizeLoading.value = true
  isSecuritizeUpdating.value = true
  isEscrowUpdating.value = true
  isEscrowLoadedOnce.value = false
  loadedChainId.value = null
  clear()
  resetVaultCategoryCache()
}

const updateEVaults = async (vaultAddresses: string[], generation?: number, silent = false, options: UpdateEVaultsOptions = {}) => {
  const { setMany: registrySetMany, get: registryGet, isKnownEscrowAddress } = useVaultRegistry()
  const gen = generation ?? loadGeneration.value

  try {
    if (!silent) {
      isEVaultUpdating.value = true
      isEVaultLoading.value = true
    }

    if (!vaultAddresses.length) {
      if (!silent) isEVaultLoading.value = false
      return
    }

    const { chainId } = useEulerAddresses()
    const sdk = await getSdkVaults()
    const result = await sdk.eVaultService.fetchVaults(
      chainId.value,
      vaultAddresses.map(addr => getAddress(addr) as Address),
      sdkVaultFetchOptions,
    )
    if (loadGeneration.value !== gen) return
    result.errors.forEach(issue => logWarn('useVaults/updateEVaults', issue))

    registrySetMany((result.result.filter(Boolean) as EVault[]).map((vault) => {
      const existing = registryGet(vault.address)
      const vaultCategory = existing?.vaultCategory ?? (isKnownEscrowAddress(vault.address) ? 'escrow' : undefined)
      const verified = vaultCategory === 'escrow' || existing?.verified === true || options.verifiedAddresses?.has(vault.address.toLowerCase()) === true
      return {
        address: vault.address,
        vault,
        type: 'evk' as const,
        verified,
        vaultCategory,
      }
    }))

    if (!silent) {
      isEVaultLoading.value = false
    }
  }
  catch (e) {
    logWarn('useVaults/updateEVaults', e)
    if (!silent && loadGeneration.value === gen) {
      isEVaultLoading.value = false
    }
  }
  finally {
    if (!silent && loadGeneration.value === gen) {
      isEVaultUpdating.value = false
    }
  }
}
const updateEarnVaults = async (vaultAddresses: string[], generation?: number, silent = false) => {
  const { setMany: registrySetMany } = useVaultRegistry()
  const gen = generation ?? loadGeneration.value

  try {
    if (!silent) {
      isEarnUpdating.value = true
      isEarnLoading.value = true
    }

    if (!vaultAddresses.length) {
      if (!silent) isEarnLoading.value = false
      return
    }

    const { chainId } = useEulerAddresses()
    const sdk = await getSdkVaults()
    const result = await sdk.eulerEarnService.fetchVaults(
      chainId.value,
      vaultAddresses.map(addr => getAddress(addr) as Address),
      sdkVaultFetchOptions,
    )
    if (loadGeneration.value !== gen) return
    result.errors.forEach(issue => logWarn('useVaults/updateEarnVaults', issue))

    registrySetMany((result.result.filter(Boolean) as EulerEarn[]).map(vault => ({
      address: vault.address,
      vault,
      type: 'earn' as const,
      verified: true,
    })))

    if (!silent) {
      isEarnLoading.value = false
    }
  }
  catch (e) {
    logWarn('useVaults/updateEarnVaults', e)
    if (!silent && loadGeneration.value === gen) {
      isEarnLoading.value = false
      isEarnUpdating.value = false
    }
  }
  // Note: isEarnUpdating is set to false in loadVaults() after all vaults are loaded
}

/**
 * Extract escrow vault addresses that are needed (used as collateral in EVaults
 * or as strategies in Earn vaults).
 */
const extractNeededEscrowAddresses = (): string[] => {
  const { getEVaults, getEarnVaults, isKnownEscrowAddress } = useVaultRegistry()
  const needed = new Set<string>()

  // 1. Escrow vaults used as collateral in EVaults — include any live edge,
  //    not just borrowable ones, so escrows mid-liquidation-LTV-ramp (where
  //    borrowLTV is already 0) still get fetched and shown in discovery.
  getEVaults().forEach((vault) => {
    vault.collaterals.forEach((ltv) => {
      if (isLiveCollateralEdge(ltv) && isKnownEscrowAddress(ltv.address)) {
        needed.add(getAddress(ltv.address))
      }
    })
  })

  // 2. Escrow vaults used as strategies in Earn vaults
  getEarnVaults().forEach((earnVault) => {
    earnVault.strategies.forEach((strategyInfo) => {
      if (isKnownEscrowAddress(strategyInfo.address)) {
        needed.add(getAddress(strategyInfo.address))
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

  const { chainId } = useEulerAddresses()
  const sdk = await getSdkVaults()
  const result = await sdk.eVaultService.fetchVaults(
    chainId.value,
    addresses.map(addr => getAddress(addr) as Address),
    sdkVaultFetchOptions,
  )

  if (loadGeneration.value !== generation) return

  result.errors.forEach(issue => logWarn('useVaults/escrow', issue))
  const entries = result.result
    .filter(Boolean)
    .map(vault => vault as EVault)
    .map(vault => ({
      address: vault.address,
      vault,
      type: 'evk' as const,
      verified: true,
      vaultCategory: 'escrow' as const,
    }))
  registrySetMany(entries)
}

/**
 * Lazy-resolve collateral addresses that aren't covered by the bulk loaders.
 *
 * `fetchChainVaultCategories` already ran earlier in this `loadVaults` call
 * and populated the per-address category cache from SDK vault metadata. We
 * group addresses by category and hand each group to the existing bulk loader
 * for that type
 * (`updateEVaults` / `updateEarnVaults` / `updateSecuritizeVaults` /
 * `fetchNeededEscrowVaults`) — same multicall batching, same registry-write
 * path, no parallel implementation. `silent=true` keeps loading flags
 * untouched since this runs after the initial reveal.
 *
 * Addresses the SDK cannot classify (category === null) are skipped — a
 * probe-and-guess fallback would misidentify brand-new escrows as plain EVault,
 * and the next `loadVaults` cycle picks them up once SDK metadata catches up.
 * The diagnostic warns in `useMarketGroups` and
 * `VaultOverviewBlockBorrow` surface the gap in the meantime.
 */
const fetchUnresolvedCollaterals = async (addresses: string[], generation: number): Promise<void> => {
  if (!addresses.length || loadGeneration.value !== generation) return

  const eVaultAddrs: string[] = []
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
        eVaultAddrs.push(addr)
        break
      case 'earn':
        earnAddrs.push(addr)
        break
      case 'securitize':
        securitizeAddrs.push(addr)
        break
      default:
        // SDK metadata has not classified this address — skip and let the next
        // loadVaults cycle pick it up once metadata catches up.
        break
    }
  }))

  if (loadGeneration.value !== generation) return

  // Bulk loaders short-circuit on empty input, so call unconditionally.
  await Promise.all([
    updateEVaults(eVaultAddrs, generation, true),
    updateEarnVaults(earnAddrs, generation, true),
    updateSecuritizeVaults(securitizeAddrs, generation, true),
    fetchNeededEscrowVaults(escrowAddrs, generation),
  ])
}

const resolveUnresolvedCollaterals = async (generation: number): Promise<void> => {
  const { getEVaults, has: registryHas } = useVaultRegistry()
  const unresolvedAddresses = extractUnresolvedCollateralAddresses(
    getEVaults(),
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

    const { chainId } = useEulerAddresses()
    const sdk = await getSdkVaults()
    const result = await sdk.securitizeVaultService.fetchVaults(
      chainId.value,
      securitizeAddresses.map(addr => getAddress(addr) as Address),
      { populateMarketPrices: true },
    )

    if (loadGeneration.value !== generation) return

    result.errors.forEach(issue => logWarn('useVaults/updateSecuritizeVaults', issue))
    const entries = result.result
      .filter(Boolean)
      .map(vault => vault as SecuritizeCollateralVault)
      .map(vault => ({
        address: vault.address,
        vault,
        type: 'securitize' as const,
        verified: true,
      }))
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

const loadVaults = async () => {
  const { chainId } = useEulerAddresses()
  const { verifiedVaultAddresses, earnVaults: earnVaultAddresses } = useEulerLabels()
  const { setEscrowAddresses } = useVaultRegistry()

  resetVaultsState()
  const generation = loadGeneration.value
  const startChainId = chainId.value

  const silent = false

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

    // Phase 1: Fetch chain-wide vault categorization from SDK metadata.
    // Addresses missing from the categorization default to EVault — the SDK
    // EVault service handles any ERC-4626 + EVault-compatible vault.
    const categories = await fetchChainVaultCategories()

    if (loadGeneration.value !== generation) return

    const securitizeSet = new Set(categories.securitize.map(a => a.toLowerCase()))
    const eVaultAddresses: string[] = []
    const securitizeAddresses: string[] = []
    explorableVaultAddresses.forEach((addr) => {
      if (securitizeSet.has(addr.toLowerCase())) {
        securitizeAddresses.push(addr)
      }
      else {
        eVaultAddresses.push(addr)
      }
    })

    // Seed the registry's escrow set from SDK-backed categorization. The SDK
    // service reads the escrow verified array, so no duplicate local RPC check
    // is needed here.
    setEscrowAddresses(categories.escrow)

    // Phase 2: fetch EVault, Earn, Securitize in parallel; follow with escrow
    // vault info once EVault collaterals + Earn strategies are known (the
    // escrow subset referenced by them is what we need to fetch details for).

    let eVaultResolve: () => void = () => {}
    let earnResolve: () => void = () => {}
    const eVaultLoaded = new Promise<void>((resolve) => {
      eVaultResolve = resolve
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
        await updateEVaults(eVaultAddresses, generation, silent, {
          verifiedAddresses: new Set(
            eVaultAddresses.map(addr => addr.toLowerCase()),
          ),
        })
        eVaultResolve()
      })(),
      updateSecuritizeVaults(securitizeAddresses, generation, silent),
      Promise.all([eVaultLoaded, earnLoaded]).then(async () => {
        const neededEscrowAddresses = extractNeededEscrowAddresses()
        await fetchNeededEscrowVaults(neededEscrowAddresses, generation)
      }),
    ])

    if (loadGeneration.value !== generation) return

    // After bulk loaders + escrow lazy-fetch settle, sweep up any collateral
    // address referenced by a member vault that isn't yet in the registry.
    // These are typically EVaults that exist on chain but aren't part of
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
    // Silent mode skips EVault/Earn flags (already false from hydration) but
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
      isEVaultLoading.value = false
      isEVaultUpdating.value = false
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
const getVault = async (address: string): Promise<EVault> => {
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

  // If vault is already in registry as an EVault, return it directly
  // This prevents overwriting escrow vaults (which have verified: true) with fetchVault results
  if (vaultType === 'evk') {
    return registryGetVault(normalizedAddress) as EVault
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
    await until(computed(() => Boolean(registryGetVault(normalizedAddress)))).toMatch(Boolean)
    return registryGetVault(normalizedAddress) as EVault
  }

  // Unlabeled address — route through the registry's resolveUnknown path so
  // we correctly detect escrow / securitize via SDK metadata, instead of
  // blindly calling the EVault service.
  // getOrFetch caches the result in the registry with the correct type tag.
  await registryGetOrFetch(normalizedAddress)
  const resolvedType = getType(normalizedAddress)
  if (resolvedType === 'securitize') {
    throw new Error('[getVault] Address is a securitize vault, use getSecuritizeVault instead')
  }
  if (resolvedType === 'earn') {
    throw new Error('[getVault] Address is an earn vault, use getEarnVault instead')
  }
  return registryGetVault(normalizedAddress) as EVault
}
const getEarnVault = async (address: string): Promise<EulerEarn> => {
  const { getVault: registryGetVault, set: registrySet } = useVaultRegistry()
  const normalizedAddress = getAddress(address)
  const { earnVaults } = useEulerLabels()

  if (earnVaults.value.includes(normalizedAddress) && !isEarnVaultNotExplorable(normalizedAddress)) {
    await until(computed(() => Boolean(registryGetVault(normalizedAddress)))).toMatch(Boolean)
  }
  else {
    const vault = await useVaultRegistry().fetchVaultByType(normalizedAddress, 'earn') as EulerEarn
    registrySet(normalizedAddress, vault, 'earn')
    return vault
  }

  return registryGetVault(normalizedAddress) as EulerEarn
}
const updateVault = async (vaultAddress: string): Promise<EVault | SecuritizeCollateralVault> => {
  const { set: registrySet, isKnownEscrowAddress, getType } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const { fetchVaultByType } = useVaultRegistry()

  // Use appropriate fetch function based on vault type
  if (getType(address) === 'securitize') {
    const vault = await fetchVaultByType(address, 'securitize') as SecuritizeCollateralVault
    registrySet(address, vault, 'securitize')
    return vault
  }

  const vault = await fetchVaultByType(address, 'evk') as EVault

  registrySet(address, vault, 'evk', isKnownEscrowAddress(address) ? { verified: true, vaultCategory: 'escrow' } : undefined)
  return vault
}
/**
 * Silent vault data refresh — updates registry in-place without resetting loading flags.
 * Used for periodic polling to keep interest rates, supply/borrow totals, and prices fresh.
 */
const refreshVaults = async () => {
  const { getEVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
  const gen = loadGeneration.value

  try {
    await updateEVaults(getEVaults().map(v => v.address), gen, true)
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

const updateEarnVault = async (vaultAddress: string): Promise<EulerEarn> => {
  const { set: registrySet } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const vault = await useVaultRegistry().fetchVaultByType(address, 'earn') as EulerEarn
  registrySet(address, vault, 'earn')
  return vault
}

const getEscrowVault = async (address: string): Promise<EVault> => {
  const { getVault: registryGetVault, isEscrowVault: registryIsEscrow, isKnownEscrowAddress, set: registrySet } = useVaultRegistry()
  const normalizedAddress = getAddress(address)

  // Wait for escrow loading to complete (address set populated, needed vaults loaded)
  if (!isEscrowLoadedOnce.value) {
    await until(isEscrowLoadedOnce).toBe(true)
  }

  // Check if already in registry with full vault info
  const existingVault = registryGetVault(normalizedAddress)
  if (existingVault && registryIsEscrow(normalizedAddress)) {
    return existingVault as EVault
  }

  // If it's a known escrow address but not in registry (wasn't needed during initial load),
  // fetch on-demand
  if (isKnownEscrowAddress(normalizedAddress)) {
    const vault = await useVaultRegistry().fetchVaultByType(normalizedAddress, 'evk') as EVault
    registrySet(normalizedAddress, vault, 'evk', { verified: true, vaultCategory: 'escrow' })
    return vault
  }

  // Last resort: try fetching anyway (might be an escrow vault not in perspective yet)
  const vault = await useVaultRegistry().fetchVaultByType(normalizedAddress, 'evk') as EVault
  registrySet(normalizedAddress, vault, 'evk')
  return vault
}

const updateEscrowVault = async (vaultAddress: string): Promise<EVault> => {
  const { set: registrySet } = useVaultRegistry()
  const address = getAddress(vaultAddress)
  const vault = await useVaultRegistry().fetchVaultByType(address, 'evk') as EVault
  registrySet(address, vault, 'evk', { verified: true, vaultCategory: 'escrow' })
  return vault
}

const getSecuritizeVault = async (address: string): Promise<SecuritizeCollateralVault> => {
  const normalizedAddress = getAddress(address)
  const { getVault: registryGetVault, getType, set: registrySet } = useVaultRegistry()

  if (getType(normalizedAddress) === 'securitize') {
    return registryGetVault(normalizedAddress) as SecuritizeCollateralVault
  }

  const vault = await useVaultRegistry().fetchVaultByType(normalizedAddress, 'securitize') as SecuritizeCollateralVault
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
    fetchVaultByType,
  } = useVaultRegistry()
  const collateralAddr = getAddress(collateralAddress)
  const borrowAddr = getAddress(borrowAddress)

  // Wait for escrow vaults to load before checking registry
  if (!isEscrowLoadedOnce.value) {
    await until(isEscrowLoadedOnce).toBe(true)
  }

  const borrowType = getType(borrowAddr)
  if (borrowType === 'evk') {
    const borrowVault = registryGetVault(borrowAddr) as EVault
    const collateralType = getType(collateralAddr)

    if (collateralType === 'evk' || collateralType === 'securitize') {
      const collateralVault = registryGetVault(collateralAddr)!
      const ltv = borrowVault.collaterals.find(c => getAddress(c.address) === collateralAddr)

      if (!ltv) {
        const vaultTypeLabel = collateralType === 'securitize' ? 'securitize vault' : (registryIsEscrow(collateralAddr) ? 'escrow vault' : 'vault')
        throw `[getBorrowVaultPair]: Collateral LTV not found for ${vaultTypeLabel}`
      }

      return {
        borrow: borrowVault,
        collateral: collateralVault,
        ltv,
      } as AnyBorrowVaultPair
    }
  }

  // Fallback: fetch borrow vault if not in registry
  const borrowVault = await fetchVaultByType(borrowAddr, 'evk') as EVault
  if (!borrowVault) {
    throw '[getBorrowVaultPair]: Borrow vault not found'
  }
  registrySet(borrowAddr, borrowVault, 'evk')

  const collateralLTV = borrowVault.collaterals.find(c => getAddress(c.address) === collateralAddr)
  if (!collateralLTV) {
    throw '[getBorrowVaultPair]: Collateral not configured for this borrow vault'
  }

  // Check collateral type from registry
  const collateralType = getType(collateralAddr)
  let collateralVault: EVault | SecuritizeCollateralVault | undefined

  if (registryIsEscrow(collateralAddr)) {
    collateralVault = await getEscrowVault(collateralAddr)
  }
  else if (collateralType === 'securitize') {
    collateralVault = registryGetVault(collateralAddr) as SecuritizeCollateralVault
  }
  else {
    try {
      collateralVault = await fetchVaultByType(collateralAddr, 'evk') as EVault
      registrySet(collateralAddr, collateralVault, 'evk')
    }
    catch {
      // Try escrow vault first
      try {
        collateralVault = await getEscrowVault(collateralAddr)
      }
      catch {
        // Check if it's a securitize vault
        const isSecuritize = await isSecuritizeVault(collateralAddr)
        if (isSecuritize) {
          collateralVault = await fetchVaultByType(collateralAddr, 'securitize') as SecuritizeCollateralVault
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
    ltv: collateralLTV,
  } as AnyBorrowVaultPair
}

export const useVaults = () => {
  // Check if vault's on-chain governorAdmin matches any of the product's declared entities
  const isVaultGovernorVerified = (vault: EVault): boolean => {
    const { entities } = useEulerLabels()
    const { getVaultCategory, isVerifiedVault } = useVaultRegistry()

    // Escrow vaults don't have a risk manager - show "-" not "Unknown"
    if (getVaultCategory(vault.address) === 'escrow') {
      return true
    }

    // Unverified vaults (not in products.json) show unknown risk manager
    if (!isVerifiedVault(vault.address)) {
      return false
    }

    const product = getProductByVault(vault.address)
    if (!product.name) {
      // Vault marked verified but not in products.json - shouldn't happen, but treat as unknown
      return false
    }

    const declaredEntityKeys = Array.isArray(product.entity) ? product.entity : [product.entity].filter(Boolean)
    if (declaredEntityKeys.length === 0) {
      // No entities declared in product, nothing to verify against
      return true
    }

    // Check if governorAdmin matches any address in any of the declared entities
    const governorAdminVerified = declaredEntityKeys.some((entityKey) => {
      const entity = entities[entityKey]
      return entity && Object.keys(entity.addresses).includes(vault.governorAdmin)
    })

    if (!governorAdminVerified) {
      return false
    }

    return true
  }

  // Check if earn vault's on-chain owner matches any of the product's declared entities
  const isEarnVaultOwnerVerified = (earnVault: EulerEarn): boolean => {
    const { entities } = useEulerLabels()
    const { isVerifiedVault } = useVaultRegistry()

    if (!isVerifiedVault(earnVault.address)) {
      return false
    }

    const product = getProductByVault(earnVault.address)
    if (!product.name) {
      return true
    }

    const declaredEntityKeys = Array.isArray(product.entity) ? product.entity : [product.entity].filter(Boolean)
    if (declaredEntityKeys.length === 0) {
      return true
    }

    const ownerAddress = getAddress(earnVault.governance.owner)
    for (const entityKey of declaredEntityKeys) {
      const entity = entities[entityKey]
      if (entity && Object.keys(entity.addresses).includes(ownerAddress)) {
        return true
      }
    }

    return false
  }

  return {
    // State
    isReady,
    isCollateralResolved,
    loadedChainId,
    isEVaultLoading,
    isEVaultUpdating,
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
    updateEVaults,
    updateEarnVaults,

    // Verification
    isSecuritizeVault,
    isVaultGovernorVerified,
    isEarnVaultOwnerVerified,

    // Business logic computed (kept for complex queries)
    borrowList,
  }
}
