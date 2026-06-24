import type {
  EulerEarn as EulerEarnClass,
  SecuritizeCollateralVault as SecuritizeCollateralVaultClass,
  EVault as EVaultClass,
  IEulerEarn,
  IEVault,
  ISecuritizeCollateralVault,
} from '@eulerxyz/euler-v2-sdk'
import {
  EVault,
  EulerEarn,
  IntrinsicApyService,
  SecuritizeCollateralVault,
} from '@eulerxyz/euler-v2-sdk'
import { extractUnresolvedCollateralAddresses } from '~/utils/vault/collateral-discovery'
import { isLiveCollateralEdge } from '~/utils/vault/ltv'
import { fetchChainVaultCategories, fetchVaultCategory, isSecuritizeVault, resetVaultCategoryCache } from '~/utils/vault/categories'
import { getProductByVault, getProductKeyByVault, isVaultNotExplorable, isEarnVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAddress, type Address } from 'viem'
import { useVaultRegistry } from './useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import {
  isEarnVaultOwnerVerified as verifyEarnVaultOwner,
  isVaultGovernorVerified as verifyVaultGovernor,
  type VerificationLabels,
} from '~/utils/vault/governor-verification'
import { liteSecuritizeVaultFetchOptions, liteVaultFetchOptions } from '~/utils/sdk-fetch-options'
import { decodeBigints } from '~/utils/snapshot-codec'
import { buildRegistryMetaService } from '~/utils/sdk-vault-meta-stub'
import {
  buildSnapshotIndex,
  buildSnapshotIntrinsicApyAdapter,
  buildSnapshotPriceService,
  buildSnapshotRewardsService,
  type SnapshotArgsByAddress,
} from '~/utils/sdk-snapshot-populate-stubs'
import type { SerialisedSnapshot, SerialisedVault } from '~/utils/snapshot-types'
import { getEulerLabelsDataForChain } from '~/composables/useEulerLabels'

const isReady = ref(false)
const isEVaultLoading = ref(false)
const isEVaultUpdating = ref(false)
const loadedChainId = ref<number | null>(null)
const loadedChainIds = ref<number[]>([])

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

// True once vault market-price fields are safe for consumers that sort or
// aggregate from the SDK instances directly. Snapshot hydration publishes the
// registry before this enrichment step, so it is intentionally stricter than
// `isReady`.
const isMarketDataResolved = ref(false)

// Generation counter to invalidate stale in-flight operations after chain switch.
// Incremented in resetVaultsState(); any async operation capturing an older generation
// must stop registering vaults.
const loadGeneration = ref(0)

interface UpdateEVaultsOptions {
  verifiedAddresses?: ReadonlySet<string>
  chainId?: number
}

const getSdkVaults = async () => {
  const { getEulerSdk } = useEulerSdk()
  return await getEulerSdk()
}

const withChainId = <T extends { chainId?: number }>(vault: T, chainId: number): T & { chainId: number } =>
  Object.assign(vault, { chainId })

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

      const collateralVault = registryGetVault(ltv.address, borrowVault.chainId)
      if (!collateralVault) return
      if (!showAllLabelEntries.value && isVaultNotExplorable(collateralVault.address)) return

      const key = `${borrowVault.chainId}:${borrowVault.address.toLowerCase()}:${ltv.address.toLowerCase()}`
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
  isMarketDataResolved.value = false
  isEVaultLoading.value = true
  isEVaultUpdating.value = true
  isEarnLoading.value = true
  isEarnUpdating.value = true
  isSecuritizeLoading.value = true
  isSecuritizeUpdating.value = true
  isEscrowUpdating.value = true
  isEscrowLoadedOnce.value = false
  loadedChainId.value = null
  loadedChainIds.value = []
  clear()
  resetVaultCategoryCache()
}

const isCurrentVaultLoad = (generation: number, targetChainId: number): boolean => {
  const { chainId, selectedChainIds } = useEulerAddresses()
  const activeChainIds = selectedChainIds?.value ?? [chainId.value].filter(Boolean)
  return loadGeneration.value === generation && activeChainIds.includes(targetChainId)
}

const resolveTargetChainId = (targetChainId?: number): number => {
  const { chainId } = useEulerAddresses()
  return targetChainId ?? chainId.value
}

const updateEVaults = async (vaultAddresses: string[], generation?: number, silent = false, options: UpdateEVaultsOptions = {}) => {
  const { setMany: registrySetMany, get: registryGet, isKnownEscrowAddress } = useVaultRegistry()
  const gen = generation ?? loadGeneration.value
  const targetChainId = resolveTargetChainId(options.chainId)

  try {
    if (!silent) {
      isEVaultUpdating.value = true
      isEVaultLoading.value = true
    }

    if (!vaultAddresses.length) {
      if (!silent) isEVaultLoading.value = false
      return
    }

    if (!isCurrentVaultLoad(gen, targetChainId)) return

    const sdk = await getSdkVaults()
    if (!isCurrentVaultLoad(gen, targetChainId)) return

    const result = await sdk.eVaultService.fetchVaults(
      targetChainId,
      vaultAddresses.map(addr => getAddress(addr) as Address),
      liteVaultFetchOptions,
    )
    if (!isCurrentVaultLoad(gen, targetChainId)) return
    result.errors.forEach(issue => logWarn('useVaults/updateEVaults', issue))

    registrySetMany((result.result.filter(Boolean) as EVault[]).map((vault) => {
      const chainedVault = withChainId(vault, targetChainId)
      const existing = registryGet(chainedVault.address, targetChainId)
      const vaultCategory = existing?.vaultCategory ?? (isKnownEscrowAddress(chainedVault.address, targetChainId) ? 'escrow' : undefined)
      const verified = vaultCategory === 'escrow' || existing?.verified === true || options.verifiedAddresses?.has(vault.address.toLowerCase()) === true
      return {
        address: chainedVault.address,
        vault: chainedVault,
        type: 'evk' as const,
        verified,
        vaultCategory,
        chainId: targetChainId,
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
const updateEarnVaults = async (vaultAddresses: string[], generation?: number, silent = false, targetChainId = resolveTargetChainId()) => {
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

    if (!isCurrentVaultLoad(gen, targetChainId)) return

    const sdk = await getSdkVaults()
    if (!isCurrentVaultLoad(gen, targetChainId)) return

    const result = await sdk.eulerEarnService.fetchVaults(
      targetChainId,
      vaultAddresses.map(addr => getAddress(addr) as Address),
      liteVaultFetchOptions,
    )
    if (!isCurrentVaultLoad(gen, targetChainId)) return
    result.errors.forEach(issue => logWarn('useVaults/updateEarnVaults', issue))

    registrySetMany((result.result.filter(Boolean) as EulerEarn[]).map(vault => ({
      address: vault.address,
      vault: withChainId(vault, targetChainId),
      type: 'earn' as const,
      verified: true,
      chainId: targetChainId,
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
const extractNeededEscrowAddresses = (targetChainId: number): string[] => {
  const { getEVaults, getEarnVaults, isKnownEscrowAddress } = useVaultRegistry()
  const needed = new Set<string>()

  // 1. Escrow vaults used as collateral in EVaults — include any live edge,
  //    not just borrowable ones, so escrows mid-liquidation-LTV-ramp (where
  //    borrowLTV is already 0) still get fetched and shown in discovery.
  getEVaults().filter(vault => vault.chainId === targetChainId).forEach((vault) => {
    vault.collaterals.forEach((ltv) => {
      if (isLiveCollateralEdge(ltv) && isKnownEscrowAddress(ltv.address, targetChainId)) {
        needed.add(getAddress(ltv.address))
      }
    })
  })

  // 2. Escrow vaults used as strategies in Earn vaults
  getEarnVaults().filter(vault => vault.chainId === targetChainId).forEach((earnVault) => {
    earnVault.strategies.forEach((strategyInfo) => {
      if (isKnownEscrowAddress(strategyInfo.address, targetChainId)) {
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
const fetchNeededEscrowVaults = async (addresses: string[], generation: number, targetChainId = resolveTargetChainId()): Promise<void> => {
  const { setMany: registrySetMany } = useVaultRegistry()

  if (!addresses.length || !isCurrentVaultLoad(generation, targetChainId)) {
    return
  }

  const sdk = await getSdkVaults()
  if (!isCurrentVaultLoad(generation, targetChainId)) return

  const result = await sdk.eVaultService.fetchVaults(
    targetChainId,
    addresses.map(addr => getAddress(addr) as Address),
    liteVaultFetchOptions,
  )

  if (!isCurrentVaultLoad(generation, targetChainId)) return

  result.errors.forEach(issue => logWarn('useVaults/escrow', issue))
  const entries = result.result
    .filter(Boolean)
    .map(vault => vault as EVault)
    .map(vault => ({
      address: vault.address,
      vault: withChainId(vault, targetChainId),
      type: 'evk' as const,
      verified: true,
      vaultCategory: 'escrow' as const,
      chainId: targetChainId,
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
const fetchUnresolvedCollaterals = async (addresses: string[], generation: number, targetChainId = resolveTargetChainId()): Promise<void> => {
  if (!addresses.length || !isCurrentVaultLoad(generation, targetChainId)) return

  const eVaultAddrs: string[] = []
  const earnAddrs: string[] = []
  const securitizeAddrs: string[] = []
  const escrowAddrs: string[] = []

  await Promise.allSettled(addresses.map(async (addr) => {
    const category = await fetchVaultCategory(addr, targetChainId)
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

  if (!isCurrentVaultLoad(generation, targetChainId)) return

  // Bulk loaders short-circuit on empty input, so call unconditionally.
  await Promise.all([
    updateEVaults(eVaultAddrs, generation, true, { chainId: targetChainId }),
    updateEarnVaults(earnAddrs, generation, true, targetChainId),
    updateSecuritizeVaults(securitizeAddrs, generation, true, targetChainId),
    fetchNeededEscrowVaults(escrowAddrs, generation, targetChainId),
  ])
}

const resolveUnresolvedCollaterals = async (generation: number, targetChainId = resolveTargetChainId()): Promise<void> => {
  const { getEVaults, has: registryHas } = useVaultRegistry()
  // Do not apply the explorable-product filter here. The matrix/group builders
  // still exclude non-explorable vaults as market members, but they need live
  // collateral references loaded in the registry so those vaults can render as
  // external collateral rows.
  const unresolvedAddresses = extractUnresolvedCollateralAddresses(
    getEVaults().filter(vault => vault.chainId === targetChainId),
    address => registryHas(address, targetChainId),
  )

  await fetchUnresolvedCollaterals(unresolvedAddresses, generation, targetChainId)
}

const updateSecuritizeVaults = async (securitizeAddresses: string[], generation: number, silent = false, targetChainId = resolveTargetChainId()) => {
  const { setMany: registrySetMany } = useVaultRegistry()

  if (!securitizeAddresses.length || !isCurrentVaultLoad(generation, targetChainId)) {
    return
  }

  try {
    if (!silent) {
      isSecuritizeUpdating.value = true
      isSecuritizeLoading.value = true
    }

    const sdk = await getSdkVaults()
    if (!isCurrentVaultLoad(generation, targetChainId)) return

    const result = await sdk.securitizeVaultService.fetchVaults(
      targetChainId,
      securitizeAddresses.map(addr => getAddress(addr) as Address),
      liteSecuritizeVaultFetchOptions,
    )

    if (!isCurrentVaultLoad(generation, targetChainId)) return

    result.errors.forEach(issue => logWarn('useVaults/updateSecuritizeVaults', issue))
    const entries = result.result
      .filter(Boolean)
      .map(vault => vault as SecuritizeCollateralVault)
      .map(vault => ({
        address: vault.address,
        vault: withChainId(vault, targetChainId),
        type: 'securitize' as const,
        verified: true,
        chainId: targetChainId,
      }))
    registrySetMany(entries)
  }
  catch (e) {
    logWarn('useVaults/updateSecuritizeVaults', e)
  }
  finally {
    if (!silent && isCurrentVaultLoad(generation, targetChainId)) {
      isSecuritizeUpdating.value = false
      isSecuritizeLoading.value = false
    }
  }
}

/**
 * Reject snapshots older than this — indicates the warm-cache plugin
 * has been stalled across multiple cycles. Falling through to a full
 * RPC load is preferable to rendering ancient TVLs / rates.
 */
const MAX_HYDRATION_AGE_MS = 6 * 60_000

const isSerialisedSnapshot = (v: unknown): v is SerialisedSnapshot => {
  if (!v || typeof v !== 'object') return false
  const s = v as Partial<SerialisedSnapshot>
  return typeof s.chainId === 'number'
    && typeof s.fetchedAt === 'number'
    && Array.isArray(s.evkVaults)
    && Array.isArray(s.earnVaults)
    && Array.isArray(s.securitizeVaults)
    && Array.isArray(s.escrowVaults)
}

type Hydrated<V> = { vault: V, args: Record<string, unknown> }

interface HydratedSnapshot {
  evk: Hydrated<EVaultClass>[]
  earn: Hydrated<EulerEarnClass>[]
  securitize: Hydrated<SecuritizeCollateralVaultClass>[]
  escrow: Hydrated<EVaultClass>[]
}

const decodeArgs = (entry: SerialisedVault): Record<string, unknown> | undefined => {
  const args = decodeBigints(entry.data) as Record<string, unknown>
  return args && typeof args === 'object' ? args : undefined
}

const instantiateEvk = (entry: SerialisedVault): Hydrated<EVaultClass> | undefined => {
  const args = decodeArgs(entry)
  return args ? { vault: new EVault(args as unknown as IEVault), args } : undefined
}

const instantiateEarn = (entry: SerialisedVault): Hydrated<EulerEarnClass> | undefined => {
  const args = decodeArgs(entry)
  return args ? { vault: new EulerEarn(args as unknown as IEulerEarn), args } : undefined
}

const instantiateSecuritize = (entry: SerialisedVault): Hydrated<SecuritizeCollateralVaultClass> | undefined => {
  const args = decodeArgs(entry)
  return args ? { vault: new SecuritizeCollateralVault(args as unknown as ISecuritizeCollateralVault), args } : undefined
}

const markHydratedSnapshotReady = (targetChainId: number) => {
  isEVaultLoading.value = false
  isEVaultUpdating.value = false
  isEarnLoading.value = false
  isEarnUpdating.value = false
  isSecuritizeLoading.value = false
  isSecuritizeUpdating.value = false
  isEscrowLoading.value = false
  isEscrowUpdating.value = false
  isEscrowLoadedOnce.value = true
  isReady.value = true
  loadedChainId.value = targetChainId
}

const enrichHydratedSnapshot = async (snapshot: HydratedSnapshot, generation: number) => {
  const { evk, escrow, earn, securitize } = snapshot
  if (loadGeneration.value !== generation) return

  const registry = useVaultRegistry()
  const meta = buildRegistryMetaService(registry)
  await Promise.all([
    ...evk.map(h => h.vault.populateCollaterals(meta)),
    ...escrow.map(h => h.vault.populateCollaterals(meta)),
    ...earn.map(h => h.vault.populateStrategyVaults(meta)),
  ])
  if (loadGeneration.value !== generation) return

  const snapshotIndex: SnapshotArgsByAddress = buildSnapshotIndex([
    ...evk, ...escrow, ...earn, ...securitize,
  ].map(h => ({ address: h.vault.address, args: h.args })))
  const priceStub = buildSnapshotPriceService(snapshotIndex)
  const rewardsStub = buildSnapshotRewardsService(snapshotIndex)
  const intrinsicApyService = new IntrinsicApyService(buildSnapshotIntrinsicApyAdapter(snapshotIndex))
  const allHydrated = [...evk, ...escrow, ...earn, ...securitize]
  await Promise.all([
    ...allHydrated.map(h => h.vault.populateMarketPrices(priceStub)),
    ...allHydrated.map(h => h.vault.populateRewards(rewardsStub)),
    intrinsicApyService.populateIntrinsicApy(allHydrated.map(h => h.vault)),
  ])
}

const scheduleHydratedSnapshotEnrichment = (snapshot: HydratedSnapshot, generation: number) => {
  const run = () => {
    void enrichHydratedSnapshot(snapshot, generation)
      .catch(err => logWarn('useVaults/enrichHydratedSnapshot', err))
      .finally(() => {
        if (loadGeneration.value === generation) {
          isMarketDataResolved.value = true
        }
      })
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: 1_000 })
    return
  }

  setTimeout(run, 0)
}

/**
 * Two-pass hydrate from the server snapshot at /api/vaults?chainId=N.
 *
 * Pass 1: instantiate every vault as its SDK class and write to the
 *         registry. Class methods are restored via the constructor; data
 *         fields come from the decoded snapshot.
 *
 * Pass 2: schedule SDK cross-reference and snapshot-backed enrichment work
 *         after the registry is published. This restores `collateral.vault`,
 *         strategy refs, market prices, rewards, and intrinsic APY without
 *         holding the initial list render behind the extra in-memory pass.
 *
 * Returns true if the registry is populated and the UI can render
 * immediately. Returns false if the snapshot is too stale, the wire
 * shape is malformed, or fetch failed — caller falls through to a
 * full RPC load.
 */
const hydrateFromServer = async (targetChainId: number, generation: number): Promise<boolean> => {
  const { setMany: registrySetMany, setEscrowAddresses } = useVaultRegistry()
  try {
    const wire = await $fetch<SerialisedSnapshot>('/api/vaults', { query: { chainId: targetChainId } })
    if (loadGeneration.value !== generation) return false

    const snap = decodeBigints(wire) as SerialisedSnapshot
    if (!isSerialisedSnapshot(snap)) {
      logWarn('useVaults/hydrateFromServer', 'server returned a malformed snapshot; falling back to RPC')
      return false
    }
    if (snap.chainId !== targetChainId) return false
    if (Date.now() - snap.fetchedAt > MAX_HYDRATION_AGE_MS) {
      logWarn(
        'useVaults/hydrateFromServer',
        `snapshot too stale (${Math.round((Date.now() - snap.fetchedAt) / 1000)}s old); falling back to RPC`,
      )
      return false
    }

    // Pass 1: instantiate + register. Keep the decoded args alongside each
    // instance so the populate-stubs in pass 2 can read snapshot fields
    // that the SDK constructors don't restore (marketPriceUsd, rewards,
    // intrinsicApy, and per-collateral marketPriceUsd).
    const isHydrated = <V>(h: Hydrated<V> | undefined): h is Hydrated<V> => h !== undefined
    const evk = snap.evkVaults.map(instantiateEvk).filter(isHydrated)
      .map(h => ({ ...h, vault: withChainId(h.vault, targetChainId) }))
    const earn = snap.earnVaults.map(instantiateEarn).filter(isHydrated)
      .map(h => ({ ...h, vault: withChainId(h.vault, targetChainId) }))
    const securitize = snap.securitizeVaults.map(instantiateSecuritize).filter(isHydrated)
      .map(h => ({ ...h, vault: withChainId(h.vault, targetChainId) }))
    const escrow = snap.escrowVaults.map(instantiateEvk).filter(isHydrated)
      .map(h => ({ ...h, vault: withChainId(h.vault, targetChainId) }))

    const escrowAddrs: string[] = escrow.map(h => h.vault.address)
    setEscrowAddresses(escrowAddrs, targetChainId)

    registrySetMany([
      ...evk.map(h => ({ address: h.vault.address, vault: h.vault, type: 'evk' as const, verified: true, chainId: targetChainId })),
      ...escrow.map(h => ({
        address: h.vault.address,
        vault: h.vault,
        type: 'evk' as const,
        verified: true,
        vaultCategory: 'escrow' as const,
        chainId: targetChainId,
      })),
      ...earn.map(h => ({ address: h.vault.address, vault: h.vault, type: 'earn' as const, verified: true, chainId: targetChainId })),
      ...securitize.map(h => ({ address: h.vault.address, vault: h.vault, type: 'securitize' as const, verified: true, chainId: targetChainId })),
    ])

    markHydratedSnapshotReady(targetChainId)
    scheduleHydratedSnapshotEnrichment({ evk, earn, securitize, escrow }, generation)
    return true
  }
  catch (err) {
    logWarn('useVaults/hydrateFromServer', err)
    return false
  }
}

const loadVaultsForChain = async (startChainId: number, generation: number) => {
  const labelsData = getEulerLabelsDataForChain(startChainId)
  const verifiedVaultAddresses = labelsData.verifiedVaultAddresses
  const earnVaultAddresses = labelsData.earnVaults
  const { setEscrowAddresses } = useVaultRegistry()

  // Phase 0: try to hydrate from the warm snapshot at /api/vaults. On
  // success the registry is populated and the UI renders immediately;
  // the subsequent RPC pipeline runs in *silent* mode so the per-category
  // loading/updating flags stay false. On failure (stale, malformed, or
  // network error) we fall through and the RPC pipeline drives the
  // loading state normally.
  const hydrated = await hydrateFromServer(startChainId, generation)
  if (!isCurrentVaultLoad(generation, startChainId)) return

  const silent = hydrated

  // Filter out non-explorable vaults before any on-chain work
  const explorableVaultAddresses = showAllLabelEntries.value
    ? verifiedVaultAddresses
    : verifiedVaultAddresses.filter(addr => !isVaultNotExplorable(addr))
  const explorableEarnAddresses = showAllLabelEntries.value
    ? earnVaultAddresses
    : earnVaultAddresses.filter(addr => !isEarnVaultNotExplorable(addr))

  try {
    if (!silent) {
      isEscrowUpdating.value = true
      isEscrowLoading.value = true
    }

    // Phase 1: Fetch chain-wide vault categorization from SDK metadata.
    // Addresses missing from the categorization default to EVault — the SDK
    // EVault service handles any ERC-4626 + EVault-compatible vault.
    if (!isCurrentVaultLoad(generation, startChainId)) return

    const categories = await fetchChainVaultCategories(startChainId)

    if (!isCurrentVaultLoad(generation, startChainId)) return

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
    setEscrowAddresses(categories.escrow, startChainId)

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
        await updateEarnVaults(explorableEarnAddresses, generation, silent, startChainId)
        earnResolve()
      })(),
      (async () => {
        await updateEVaults(eVaultAddresses, generation, silent, {
          chainId: startChainId,
          verifiedAddresses: new Set(
            eVaultAddresses.map(addr => addr.toLowerCase()),
          ),
        })
        eVaultResolve()
      })(),
      updateSecuritizeVaults(securitizeAddresses, generation, silent, startChainId),
      Promise.all([eVaultLoaded, earnLoaded]).then(async () => {
        const neededEscrowAddresses = extractNeededEscrowAddresses(startChainId)
        await fetchNeededEscrowVaults(neededEscrowAddresses, generation, startChainId)
      }),
    ])

    if (!isCurrentVaultLoad(generation, startChainId)) return

    // After bulk loaders + escrow lazy-fetch settle, sweep up any collateral
    // address referenced by a member vault that isn't yet in the registry.
    // These are typically EVaults that exist on chain but aren't part of
    // any product label — without this, discovery views silently drop the
    // relationship. Single pass is enough: discovery views iterate only
    // member vaults, so a resolved off-label vault is a leaf in those views;
    // any second-hop unknowns will surface as diagnostic warns and resolve
    // on the next loadVaults cycle.
    await resolveUnresolvedCollaterals(generation, startChainId)

    if (!isCurrentVaultLoad(generation, startChainId)) return

    // Bulk loaders + unresolved-collateral sweep are complete. Consumers
    // gating "unknown collateral" classification can now run without
    // misclassifying not-yet-hydrated lazy collateral references.
    isCollateralResolved.value = true
    isMarketDataResolved.value = true

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
      isMarketDataResolved.value = true
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
    if (loadGeneration.value === generation) {
      isReady.value = true
      if (!loadedChainIds.value.includes(startChainId)) {
        loadedChainIds.value = [...loadedChainIds.value, startChainId].sort((a, b) => a - b)
      }
      const { chainId } = useEulerAddresses()
      if (chainId.value === startChainId) {
        loadedChainId.value = startChainId
      }
    }
  }
}

const loadVaults = async () => {
  const { selectedChainIds, chainId } = useEulerAddresses()
  resetVaultsState()
  const generation = loadGeneration.value
  const selectedIds = selectedChainIds?.value ?? []
  const targetChainIds = selectedIds.length ? selectedIds : [chainId.value].filter(Boolean)

  await Promise.all(targetChainIds.map(targetChainId => loadVaultsForChain(targetChainId, generation)))

  if (loadGeneration.value === generation) {
    isReady.value = true
    if (!loadedChainId.value && chainId.value && loadedChainIds.value.includes(chainId.value)) {
      loadedChainId.value = chainId.value
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
const refreshVaultsForChain = async (targetChainId: number, gen: number) => {
  const { getEVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
  const eVaultAddresses = getEVaults()
    .filter(vault => vault.chainId === targetChainId)
    .map(v => v.address)
  const earnAddresses = getEarnVaults()
    .filter(vault => vault.chainId === targetChainId)
    .map(v => v.address)
  const securitizeAddresses = getSecuritizeVaults()
    .filter(vault => vault.chainId === targetChainId)
    .map(v => v.address)

  try {
    await updateEVaults(eVaultAddresses, gen, true, { chainId: targetChainId })
    if (!isCurrentVaultLoad(gen, targetChainId)) return

    await resolveUnresolvedCollaterals(gen, targetChainId)
    if (!isCurrentVaultLoad(gen, targetChainId)) return
  }
  catch (e) {
    logWarn('useVaults/refreshVaults', e)
  }
  finally {
    if (isCurrentVaultLoad(gen, targetChainId)) {
      isCollateralResolved.value = true
    }
  }

  if (!isCurrentVaultLoad(gen, targetChainId)) return

  await updateEarnVaults(earnAddresses, gen, true, targetChainId)
  if (!isCurrentVaultLoad(gen, targetChainId)) return

  await updateSecuritizeVaults(securitizeAddresses, gen, true, targetChainId)
}

const refreshVaults = async () => {
  const { selectedChainIds, chainId } = useEulerAddresses()
  const gen = loadGeneration.value
  const targetChainIds = loadedChainIds.value.length
    ? loadedChainIds.value
    : selectedChainIds.value.length
      ? selectedChainIds.value
      : [chainId.value].filter(Boolean)

  await Promise.all(targetChainIds.map(targetChainId => refreshVaultsForChain(targetChainId, gen)))
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

  // Wait for escrow loading to complete (address set populated, needed vaults loaded).
  // Timeout prevents an indefinite hang when a superseded loadVaults generation
  // never flips the flag back to true.
  if (!isEscrowLoadedOnce.value) {
    await Promise.race([
      until(isEscrowLoadedOnce).toBe(true),
      new Promise<void>(resolve => setTimeout(resolve, 10_000)),
    ])
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

  // Wait for snapshot enrichment / RPC refresh before resolving a one-time
  // direct-route pair; otherwise the page can capture vault instances before
  // rewards and market data have been populated.  Timeout prevents an
  // indefinite hang when a superseded loadVaults generation never flips the
  // flag back to true.
  if (!isMarketDataResolved.value) {
    await Promise.race([
      until(isMarketDataResolved).toBe(true),
      new Promise<void>(resolve => setTimeout(resolve, 10_000)),
    ])
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
  const buildVerificationLabels = (): VerificationLabels => {
    const { entities } = useEulerLabels()
    return {
      getDeclaredEntityKeys: (vaultAddress) => {
        const productKey = getProductKeyByVault(vaultAddress)
        if (!productKey) return undefined
        const product = getProductByVault(vaultAddress)
        return Array.isArray(product.entity) ? product.entity : [product.entity].filter(Boolean)
      },
      hasEntityAddress: (entityKey, address) => {
        const entity = entities[entityKey]
        return !!entity && Object.keys(entity.addresses ?? {}).includes(address)
      },
    }
  }

  // Check if vault's on-chain governorAdmin matches any of the product's declared entities
  const isVaultGovernorVerified = (vault: EVault): boolean => {
    const { getVaultCategory, isVerifiedVault } = useVaultRegistry()
    const vaultCategory = getVaultCategory(vault.address)
    return verifyVaultGovernor(
      Object.assign(vault, {
        verified: vaultCategory === 'escrow' || isVerifiedVault(vault.address),
        vaultCategory,
      }),
      buildVerificationLabels(),
    )
  }

  // Check if securitize vault's on-chain governor matches any of the product's
  // declared entities. Mirrors the server (server/utils/verified-vaults.ts),
  // which runs securitize through the same governor rule rather than trusting
  // bare list membership. The SDK securitize type exposes `governor` (not
  // `governorAdmin`); the shared rule reads `governorAdmin ?? governor`.
  const isSecuritizeGovernorVerified = (vault: SecuritizeCollateralVault): boolean => {
    const { isVerifiedVault } = useVaultRegistry()
    return verifyVaultGovernor(
      Object.assign(vault, { verified: isVerifiedVault(vault.address) }),
      buildVerificationLabels(),
    )
  }

  // Check if earn vault's on-chain owner matches any of the product's declared entities
  const isEarnVaultOwnerVerified = (earnVault: EulerEarn): boolean => {
    const { isVerifiedVault } = useVaultRegistry()
    return verifyEarnVaultOwner(
      Object.assign(earnVault, { verified: isVerifiedVault(earnVault.address) }),
      buildVerificationLabels(),
    )
  }

  return {
    // State
    isReady,
    isCollateralResolved,
    isMarketDataResolved,
    loadedChainId,
    loadedChainIds,
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
    isSecuritizeGovernorVerified,
    isEarnVaultOwnerVerified,

    // Business logic computed (kept for complex queries)
    borrowList,
  }
}
