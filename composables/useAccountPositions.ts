import { getAddress, type Abi } from 'viem'
import { computed, ref, type Ref } from 'vue'
import * as Sentry from '@sentry/nuxt'
import { useVaultRegistry } from './useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import { FixedPoint } from '~/utils/fixed-point'
import type { SubgraphPositionEntry } from '~/utils/subgraph'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import type { EulerLensAddresses } from '~/composables/useEulerAddresses'
import { createRaceGuard } from '~/utils/race-guard'
import { BPS_BASE } from '~/entities/tuning-constants'
import type {
  AccountBorrowPosition, AccountDepositPosition,
} from '~/entities/account'
import type {
  EVault,
  SecuritizeCollateralVault,
} from '~/entities/vault'
import { fetchVaultCategory } from '~/entities/vault/factory'
import { getAssetOraclePrice, getCollateralUsdPrice } from '~/services/pricing/priceProvider'
import { batchLensCalls } from '~/utils/multicall'
import {
  type LensAccountInfo,
  type LensVaultAccountInfo,
  resolvePositionCollaterals,
  toBigInt,
} from '~/utils/accountPositionHelpers'

// Internal storage — always contains ALL positions (verified + unverified)
const _allDepositPositions: Ref<AccountDepositPosition[]> = ref([])
const _allBorrowPositions: Ref<AccountBorrowPosition[]> = ref([])

// Unresolved positions — subgraph reported them but we couldn't materialise
// the position, either because the vault object itself couldn't be resolved
// (`fetch-failed` / `collateral-unresolved`) or because the per-account lens
// call failed (`lens-failed`: RPC transport error or individual-call revert).
// Surfaced on the portfolio page as an aggregate count so users know their
// position exists even when we can't render details.
export type UnresolvedPositionKind = 'deposit' | 'borrow'
export type UnresolvedPositionReason = 'fetch-failed' | 'collateral-unresolved' | 'lens-failed'

export interface UnresolvedPosition {
  subAccount: string
  vault: string
  kind: UnresolvedPositionKind
  reason: UnresolvedPositionReason
}

const _unresolvedPositions: Ref<UnresolvedPosition[]> = shallowRef([])

// Keys captured during the current refresh cycle (reset at `beginRefreshCycle`,
// used at `finalizeRefreshCycle` to prune entries from previous refreshes that
// are no longer failing). Letting the displayed list persist across a refresh
// (rather than clearing up-front) prevents the banner from flashing every poll.
const currentRefreshCapturedKeys = new Set<string>()

// Session-level dedup for Sentry emissions: `${chainId}:${vault}:${reason}`.
// Cleared alongside positions on chain or address switch, so a broken RPC
// recovering-and-failing-again re-emits once, rather than every 60s poll.
const sentryEmittedKeys = new Set<string>()

// Track which (subAccount, vaultAddress) pairs are used as collateral
// Format: "subAccount:vaultAddress" (both checksummed)
const collateralUsageSet: Ref<Set<string>> = shallowRef(new Set())

const isPositionsLoading = ref(true)
const isPositionsLoaded = ref(false)
const isDepositsLoading = ref(true)
const isDepositsLoaded = ref(false)
const isShowAllPositions = ref(false)

// Filtered views — instant toggle, no network calls
const borrowPositions = computed(() => {
  if (isShowAllPositions.value) return _allBorrowPositions.value
  const { isVerifiedVault } = useVaultRegistry()
  return _allBorrowPositions.value.filter(p => isVerifiedVault(p.borrow.address) && isVerifiedVault(p.collateral.address))
})
const allBorrowPositions = computed(() => _allBorrowPositions.value)
const depositPositions = computed(() => {
  if (isShowAllPositions.value) return _allDepositPositions.value
  const { isVerifiedVault } = useVaultRegistry()
  return _allDepositPositions.value.filter(p => isVerifiedVault(p.vault.address))
})
const hiddenBorrowCount = computed(() =>
  _allBorrowPositions.value.length - borrowPositions.value.length,
)
const hiddenDepositCount = computed(() =>
  _allDepositPositions.value.length - depositPositions.value.length,
)

// Generation counter to invalidate stale in-flight position fetches after chain switch.
// Incremented on chain change; async operations capturing an older generation discard results.
const positionGuard = createRaceGuard()

const clearUnresolvedPositions = () => {
  _unresolvedPositions.value = []
  currentRefreshCapturedKeys.clear()
}

// Called by the orchestrator at the start of a refresh. We don't clear the
// displayed list here — that would flash the banner off on every 60s poll —
// only the per-refresh capture set, so `finalizeRefreshCycle` knows which
// entries were re-captured this round.
const beginRefreshCycle = () => {
  currentRefreshCapturedKeys.clear()
}

// Called by the orchestrator after a successful refresh. Prunes entries from
// `_unresolvedPositions` whose `(subAccount, vault)` wasn't re-captured this
// cycle — that's how we remove positions that recovered (the underlying RPC
// call now succeeds). Errored refreshes skip this step so a transient error
// doesn't erroneously prune still-failing entries.
const finalizeRefreshCycle = () => {
  if (_unresolvedPositions.value.length === 0) return
  const next = _unresolvedPositions.value.filter(p =>
    currentRefreshCapturedKeys.has(`${p.subAccount}:${p.vault}`),
  )
  if (next.length !== _unresolvedPositions.value.length) {
    _unresolvedPositions.value = next
  }
}

// Best-effort lookup; does not block capture. Used only to classify Sentry
// events by vault type. The async category fetch is SDK-backed.
const resolveVaultType = async (
  vault: string,
): Promise<'evk' | 'earn' | 'securitize' | 'unknown'> => {
  const { getType } = useVaultRegistry()
  const cached = getType(vault)
  if (cached === 'earn' || cached === 'securitize' || cached === 'evk') return cached

  const category = await fetchVaultCategory(vault).catch(() => null)
  if (category === 'earn' || category === 'securitize') return category
  if (category === 'evk' || category === 'escrow') return 'evk'
  return 'unknown'
}

// Register a position the subgraph reported but we couldn't materialise.
// Dedup ignores `kind` so a failed borrow-collateral isn't double-counted
// when the same vault re-appears in the deposit feed.
const registerUnresolved = (
  subAccount: string,
  vault: string,
  kind: UnresolvedPositionKind,
  reason: UnresolvedPositionReason,
  generation: number,
): void => {
  if (positionGuard.isStale(generation)) return

  let normalizedVault: string
  let normalizedSubAccount: string
  try {
    normalizedVault = getAddress(vault)
    normalizedSubAccount = getAddress(subAccount)
  }
  catch {
    return
  }

  const positionKey = `${normalizedSubAccount}:${normalizedVault}`
  // Record the capture so finalize knows not to prune this entry.
  currentRefreshCapturedKeys.add(positionKey)

  const alreadyCaptured = _unresolvedPositions.value.some(p =>
    p.subAccount === normalizedSubAccount && p.vault === normalizedVault,
  )
  if (alreadyCaptured) return

  _unresolvedPositions.value = [..._unresolvedPositions.value, {
    subAccount: normalizedSubAccount,
    vault: normalizedVault,
    kind,
    reason,
  }]

  try {
    const { chainId } = useEulerAddresses()
    const runtimeConfig = useRuntimeConfig()
    const currentChainId = chainId.value || 'unknown'
    const dedupKey = `${currentChainId}:${normalizedVault}:${reason}`
    if (!runtimeConfig.public.sentryDsn || sentryEmittedKeys.has(dedupKey)) return
    sentryEmittedKeys.add(dedupKey)

    // Resolve the type asynchronously; report once it's known so the Sentry
    // event carries a useful `vaultType` tag. Address is deliberately omitted
    // from the payload: subAccount is wallet-derived (wallet XOR sub-index),
    // pairing it with session replay correlates replays to specific users.
    void resolveVaultType(normalizedVault).then((vaultType) => {
      Sentry.captureMessage('Unresolved position', {
        level: 'warning',
        tags: {
          chainId: currentChainId,
          vaultType,
          kind,
          reason,
        },
        contexts: {
          unresolved: { vault: normalizedVault, kind, reason },
        },
      })
    })
  }
  catch (e) {
    logWarn('useAccountPositions/registerUnresolved/sentry', e)
  }
}

const updateBorrowPositions = async (
  eulerLensAddresses: EulerLensAddresses,
  address: string,
  borrowEntries: SubgraphPositionEntry[],
  isInitialLoading = false,
) => {
  const gen = positionGuard.current()

  if (isInitialLoading) {
    isPositionsLoaded.value = false
    isPositionsLoading.value = true
    _allBorrowPositions.value = []
  }

  if (!address) {
    _allBorrowPositions.value = []
    isPositionsLoading.value = false
    isPositionsLoaded.value = true
    return
  }

  const { rpcUrl } = useRpcClient()
  const { getOrFetch } = useVaultRegistry()
  const { eulerCoreAddresses } = useEulerAddresses()

  if (!eulerLensAddresses?.accountLens) {
    throw new Error('Euler addresses not loaded yet')
  }

  const evcAddress = eulerCoreAddresses.value?.evc
  if (!evcAddress) {
    throw new Error('EVC address not loaded yet')
  }

  // ── Phase A: Batch all getAccountInfo calls ─────────────────────────
  // Pre-resolve vaults from registry (should be cache hits) to classify Pyth vs non-Pyth
  const entryVaults = await Promise.all(
    borrowEntries.map(async entry => ({
      entry,
      vault: await getOrFetch(entry.vault) as EVault | undefined,
    })),
  )

  if (positionGuard.isStale(gen)) return

  type NonPythEntry = { key: string, entry: SubgraphPositionEntry, vault: EVault | undefined }
  const nonPythEntries: NonPythEntry[] = entryVaults.map(({ entry, vault }) => ({
    key: `${entry.subAccount}:${entry.vault}`,
    entry,
    vault,
  }))

  // Batch non-Pyth getAccountInfo calls via EVC batchSimulation
  const accountInfoMap = new Map<string, LensAccountInfo>()

  if (nonPythEntries.length > 0) {
    const calls = nonPythEntries.map(({ entry }) => ({
      functionName: 'getAccountInfo',
      args: [entry.subAccount, entry.vault],
    }))

    const results = await batchLensCalls<LensAccountInfo>(
      evcAddress,
      eulerLensAddresses.accountLens,
      eulerAccountLensABI as Abi,
      calls,
      rpcUrl.value,
    )

    let hasTransportError = false
    for (let i = 0; i < results.length; i++) {
      if (results[i].transportError) {
        hasTransportError = true
        registerUnresolved(nonPythEntries[i].entry.subAccount, nonPythEntries[i].entry.vault, 'borrow', 'lens-failed', gen)
      }
      else if (results[i].success && results[i].result) {
        accountInfoMap.set(nonPythEntries[i].key, results[i].result!)
      }
      else {
        registerUnresolved(nonPythEntries[i].entry.subAccount, nonPythEntries[i].entry.vault, 'borrow', 'lens-failed', gen)
      }
    }
    if (hasTransportError) logWarn('useAccountPositions/accountInfo', 'RPC transport error — account info results may be incomplete')
  }

  if (positionGuard.isStale(gen)) return

  // ── Phase B: Process results, batch getVaultAccountInfo calls ───────
  type ProcessedEntry = {
    entry: SubgraphPositionEntry
    res: LensAccountInfo
    borrowVault: EVault
    collateral: EVault | SecuritizeCollateralVault
    collaterals: string[]
    collateralAddress: string
  }
  const processed: ProcessedEntry[] = []

  for (const { entry, vault: prefetchedVault } of entryVaults) {
    const key = `${entry.subAccount}:${entry.vault}`
    const res = accountInfoMap.get(key)

    if (!res || !res.evcAccountInfo.enabledControllers.length || !res.evcAccountInfo.enabledCollaterals.length || res.vaultAccountInfo.borrowed === 0n) {
      continue
    }

    const enabledCollateralsList = res.evcAccountInfo.enabledCollaterals.map(c => getAddress(c))
    const collaterals = resolvePositionCollaterals(res.vaultAccountInfo?.liquidityInfo, enabledCollateralsList)

    const borrowAddress = getAddress(res.evcAccountInfo.enabledControllers[0])
    const borrow = prefetchedVault && prefetchedVault.address.toLowerCase() === borrowAddress.toLowerCase()
      ? prefetchedVault
      : await getOrFetch(borrowAddress) as EVault | undefined
    if (!borrow) {
      registerUnresolved(entry.subAccount, borrowAddress, 'borrow', 'fetch-failed', gen)
      continue
    }

    let collateralAddress: string | undefined
    const collateralCandidates = collaterals.length ? collaterals : enabledCollateralsList
    for (const addr of collateralCandidates) {
      if (borrow.collaterals.some(ltv => getAddress(ltv.address) === addr)) {
        collateralAddress = addr
        break
      }
    }
    if (!collateralAddress) collateralAddress = collateralCandidates[0]
    if (!collateralAddress) continue

    const collateral = await getOrFetch(collateralAddress) as EVault | SecuritizeCollateralVault | undefined
    if (!collateral) {
      registerUnresolved(entry.subAccount, collateralAddress, 'borrow', 'collateral-unresolved', gen)
      continue
    }

    processed.push({
      entry,
      res,
      borrowVault: borrow,
      collateral,
      collaterals,
      collateralAddress,
    })
  }

  if (positionGuard.isStale(gen)) return

  // Batch all getVaultAccountInfo calls for collateral balances
  const collateralAssets = new Map<string, bigint>()

  if (processed.length > 0) {
    const collateralCalls = processed.map(p => ({
      functionName: 'getVaultAccountInfo',
      args: [p.entry.subAccount, p.collateralAddress],
    }))

    const collateralResults = await batchLensCalls<LensVaultAccountInfo>(
      evcAddress,
      eulerLensAddresses.accountLens,
      eulerAccountLensABI as Abi,
      collateralCalls,
      rpcUrl.value,
    )

    let hasTransportError = false
    for (let i = 0; i < collateralResults.length; i++) {
      const r = collateralResults[i]
      if (r.transportError) hasTransportError = true
      else if (r.success && r.result) {
        const key = `${processed[i].entry.subAccount}:${processed[i].collateralAddress}`
        collateralAssets.set(key, toBigInt(r.result.assets))
      }
    }
    if (hasTransportError) logWarn('useAccountPositions/collateralInfo', 'RPC transport error — collateral asset results may be incomplete')
  }

  if (positionGuard.isStale(gen)) return

  // ── Build final positions ───────────────────────────────────────────
  const borrowResults = await Promise.all(processed.map(async (p) => {
    const suppliedAssets = collateralAssets.get(`${p.entry.subAccount}:${p.collateralAddress}`) ?? 0n

    const liquidityInfo = p.res.vaultAccountInfo.liquidityInfo
    const hasQueryFailure = Boolean(liquidityInfo.queryFailure)

    if (hasQueryFailure) {
      const ltvConfig = p.borrowVault.collaterals.find(ltv =>
        getAddress(ltv.address) === getAddress(p.collateral.address),
      )
      return {
        borrow: p.borrowVault,
        collateral: p.collateral,
        collaterals: p.collaterals,
        subAccount: p.entry.subAccount,
        borrowed: p.res.vaultAccountInfo.borrowed,
        supplied: suppliedAssets,
        borrowLTV: ltvConfig?.borrowLTV ?? 0n,
        liquidationLTV: ltvConfig?.liquidationLTV ?? 0n,
        health: 0n,
        userLTV: 0n,
        price: 0n,
        liabilityValueBorrowing: 0n,
        liabilityValueLiquidation: 0n,
        timeToLiquidation: 0n,
        collateralValueLiquidation: 0n,
        liquidityQueryFailure: true,
      } as AccountBorrowPosition
    }

    const collateralValueLiquidation = liquidityInfo.collateralValueLiquidation
    const collateralValueRaw = liquidityInfo.collateralValueRaw
    let liabilityValueBorrowing = liquidityInfo.liabilityValueBorrowing

    const liquidationLTV = collateralValueRaw > 0n
      ? collateralValueLiquidation * BPS_BASE / collateralValueRaw
      : 0n
    const effectiveBorrowLTV = collateralValueRaw > 0n
      ? liquidityInfo.collateralValueBorrowing * BPS_BASE / collateralValueRaw
      : 0n

    if (liabilityValueBorrowing === 0n && p.res.vaultAccountInfo.borrowed > 0n) {
      logWarn('updateBorrowPositions', 'liabilityValueBorrowing is 0 but borrowed amount exists, calculating manually')
      const borrowOraclePrice = getAssetOraclePrice(p.borrowVault)
      const borrowedInUnitOfAccount = FixedPoint.fromValue(p.res.vaultAccountInfo.borrowed, p.borrowVault.asset.decimals)
        .mul(FixedPoint.fromValue(borrowOraclePrice?.amountOutMid ?? 0n, 18))
      liabilityValueBorrowing = borrowedInUnitOfAccount.value
    }

    const healthFixed = liabilityValueBorrowing === 0n
      ? FixedPoint.fromValue(0n, 18)
      : FixedPoint.fromValue(collateralValueLiquidation, 18).div(FixedPoint.fromValue(liabilityValueBorrowing, 18))

    const userLTVFixed = healthFixed.isZero()
      ? FixedPoint.fromValue(0n, 18)
      : FixedPoint.fromValue(liquidationLTV * (10n ** 16n), 18).div(healthFixed)
    const userLTV = userLTVFixed.value

    const collateralPriceUsd = await getCollateralUsdPrice(p.borrowVault, p.collateral, 'off-chain')

    if (!collateralPriceUsd) {
      return {
        borrow: p.borrowVault,
        collateral: p.collateral,
        collaterals: p.collaterals,
        subAccount: p.entry.subAccount,
        borrowed: p.res.vaultAccountInfo.borrowed,
        supplied: suppliedAssets,
        borrowLTV: effectiveBorrowLTV,
        liquidationLTV,
        health: healthFixed.value,
        userLTV,
        price: 0n,
        liabilityValueBorrowing,
        liabilityValueLiquidation: liquidityInfo.liabilityValueLiquidation,
        timeToLiquidation: liquidityInfo.timeToLiquidation,
        collateralValueLiquidation,
        liquidityQueryFailure: true,
      } as AccountBorrowPosition
    }

    const supplyLiquidationPriceRatio = collateralValueLiquidation === 0n
      ? FixedPoint.fromValue(0n, 18)
      : FixedPoint.fromValue(liabilityValueBorrowing, 18)
          .div(FixedPoint.fromValue(collateralValueLiquidation, 18))

    const currentCollateralPriceUsd = FixedPoint.fromValue(collateralPriceUsd.amountOutMid, 18)
    const price = currentCollateralPriceUsd.mul(supplyLiquidationPriceRatio).value

    return {
      borrow: p.borrowVault,
      collateral: p.collateral,
      collaterals: p.collaterals,
      subAccount: p.entry.subAccount,
      borrowLTV: effectiveBorrowLTV,
      timeToLiquidation: liquidityInfo.timeToLiquidation,
      health: healthFixed.value,
      borrowed: p.res.vaultAccountInfo.borrowed,
      price,
      userLTV,
      supplied: suppliedAssets,
      liabilityValueBorrowing,
      liabilityValueLiquidation: liquidityInfo.liabilityValueLiquidation,
      liquidationLTV,
      collateralValueLiquidation,
    } as AccountBorrowPosition
  }))

  if (positionGuard.isStale(gen)) return

  const borrows = borrowResults.filter((o): o is AccountBorrowPosition => !!o)
  _allBorrowPositions.value = borrows

  // Build set of (subAccount, collateralVault) pairs used as collateral
  const usageSet = new Set<string>()
  for (const pos of borrows) {
    const subAccount = getAddress(pos.subAccount)
    for (const addr of pos.collaterals ?? [pos.collateral.address]) {
      usageSet.add(`${subAccount}:${getAddress(addr)}`)
    }
  }
  collateralUsageSet.value = usageSet

  isPositionsLoading.value = false
  isPositionsLoaded.value = true
}

const updateSavingsPositions = async (
  eulerLensAddresses: EulerLensAddresses,
  address: string,
  depositEntries: SubgraphPositionEntry[],
  isInitialLoading = false,
  generation?: number,
) => {
  const gen = generation ?? positionGuard.current()

  if (isInitialLoading) {
    isDepositsLoaded.value = false
    isDepositsLoading.value = true
    _allDepositPositions.value = []
  }

  if (!address) {
    isDepositsLoaded.value = false
    isDepositsLoading.value = true
    _allDepositPositions.value = []
    return
  }

  const { getOrFetch } = useVaultRegistry()
  const { rpcUrl } = useRpcClient()
  const { eulerCoreAddresses } = useEulerAddresses()

  if (!eulerLensAddresses?.accountLens) {
    throw new Error('Euler addresses not loaded yet')
  }

  const evcAddress = eulerCoreAddresses.value?.evc
  if (!evcAddress) {
    throw new Error('EVC address not loaded yet')
  }

  // Pre-filter: resolve vaults and exclude collateral-used entries
  type ValidEntry = { entry: SubgraphPositionEntry, vault: NonNullable<Awaited<ReturnType<typeof getOrFetch>>> }
  const validEntries: ValidEntry[] = []

  for (const entry of depositEntries) {
    const collateralKey = `${entry.subAccount}:${entry.vault}`
    if (collateralUsageSet.value.has(collateralKey)) continue

    const vault = await getOrFetch(entry.vault)
    if (!vault) {
      registerUnresolved(entry.subAccount, entry.vault, 'deposit', 'fetch-failed', gen)
      continue
    }

    validEntries.push({ entry, vault })
  }

  if (positionGuard.isStale(gen)) return

  // Batch all getAccountInfo calls in one RPC request
  const deposits: AccountDepositPosition[] = []

  if (validEntries.length > 0) {
    const calls = validEntries.map(({ entry }) => ({
      functionName: 'getAccountInfo',
      args: [entry.subAccount, entry.vault],
    }))

    const results = await batchLensCalls<LensAccountInfo>(
      evcAddress,
      eulerLensAddresses.accountLens,
      eulerAccountLensABI as Abi,
      calls,
      rpcUrl.value,
    )

    let hasTransportError = false
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.transportError) {
        hasTransportError = true
        registerUnresolved(validEntries[i].entry.subAccount, validEntries[i].entry.vault, 'deposit', 'lens-failed', gen)
        continue
      }
      if (!r.success || !r.result) {
        registerUnresolved(validEntries[i].entry.subAccount, validEntries[i].entry.vault, 'deposit', 'lens-failed', gen)
        continue
      }

      const res = r.result
      if (res.vaultAccountInfo.shares === 0n) continue

      deposits.push({
        vault: validEntries[i].vault,
        subAccount: validEntries[i].entry.subAccount,
        shares: res.vaultAccountInfo.shares,
        assets: res.vaultAccountInfo.assets,
      } as AccountDepositPosition)
    }
    if (hasTransportError) logWarn('useAccountPositions/depositInfo', 'RPC transport error — deposit position results may be incomplete')
  }

  if (positionGuard.isStale(gen)) return

  _allDepositPositions.value = deposits
  isDepositsLoading.value = false
  isDepositsLoaded.value = true
}

const clearPositions = () => {
  _allBorrowPositions.value = []
  _allDepositPositions.value = []
  collateralUsageSet.value = new Set()
  _unresolvedPositions.value = []
  currentRefreshCapturedKeys.clear()
  // Chain/address switch also resets the Sentry session dedup so a recovered
  // endpoint that starts failing again emits once more.
  sentryEmittedKeys.clear()
}

const unresolvedBorrowCount = computed(
  () => _unresolvedPositions.value.filter(p => p.kind === 'borrow').length,
)
const unresolvedDepositCount = computed(
  () => _unresolvedPositions.value.filter(p => p.kind === 'deposit').length,
)

export const useAccountPositions = () => ({
  allBorrowPositions,
  depositPositions,
  borrowPositions,
  collateralUsageSet,
  isPositionsLoading,
  isPositionsLoaded,
  isDepositsLoading,
  isDepositsLoaded,
  isShowAllPositions,
  hiddenBorrowCount,
  hiddenDepositCount,
  positionGuard,
  unresolvedBorrowCount,
  unresolvedDepositCount,
  updateBorrowPositions,
  updateSavingsPositions,
  clearPositions,
  clearUnresolvedPositions,
  beginRefreshCycle,
  finalizeRefreshCycle,
})
