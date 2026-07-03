import { type Address, getAddress, zeroAddress } from 'viem'
import { useVaults } from '~/composables/useVaults'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { activeLayerWalletBalancesRef } from '~/composables/useTxBatch'
import { logWarn } from '~/utils/errorHandling'
import { FULL_BALANCES_TTL_MS } from '~/entities/tuning-constants'

// When a simulated batch layer is active, return its stitched wallet balance for
// a touched token in place of the real balance. No-op for untouched tokens or
// the base layer (ref empty), so wallet reads stay transparent.
const applyLayerOverlay = (tokenAddress: string, realBalance: bigint): bigint => {
  const key = (() => {
    try {
      return getAddress(tokenAddress).toLowerCase()
    }
    catch {
      return tokenAddress.toLowerCase()
    }
  })()
  const simulated = activeLayerWalletBalancesRef.value[key]
  return simulated !== undefined ? simulated : realBalance
}

// Singleton state
const balances = shallowRef(new Map<string, bigint>())
const isLoaded = ref(false)
const isFetching = ref(false)
const lastFetchChainId = ref<number | null>(null)
const lastFetchAddress = ref<string | null>(null)
let fetchPromise: Promise<void> | null = null

// Reference-counted flag: when >0, updateBalances includes the full token list
// (all Uniswap/DefiLlama entries — thousands of tokens on mainnet) so pages
// with the "pay with" token selector can show non-zero balances first.
// When 0 (the default), updateBalances fetches only vault-asset balances
// (a few dozen tokens at most) — enough for Max buttons, balance chips, and
// wallet-sourced-repay dropdowns on the main navigation pages.
const fullBalancesRequesters = ref(0)

// Remembers the most recent (chain, address) that completed a full-mode fetch
// and when. Lets useFullBalances skip a redundant refetch when the user
// navigates between two swap pages within the TTL window.
// resetBalances() clears this alongside the Map, so chain / wallet changes
// correctly force a refetch.
let lastFullFetchKey: string | null = null
let lastFullFetchAt = 0

export const useWallets = () => {
  const { loadedChainId } = useVaults()
  const { getByType } = useVaultRegistry()
  const { address, isConnected } = useWagmi()
  const { chainId } = useEulerAddresses()

  const { spyAddress, isSpyMode } = useSpyMode()
  const balanceAddress = computed(() =>
    isSpyMode.value ? spyAddress.value : address.value,
  )

  const updateBalances = async () => {
    // Guard: must be connected or in spy mode
    if (!balanceAddress.value || (!isConnected.value && !isSpyMode.value)) {
      return
    }

    // Capture chainId and full-balance mode up-front so we can (a) filter out
    // stale cross-chain token-list entries, (b) discard results if the chain
    // changes mid-fetch, and (c) only stamp lastFullFetchKey when the fetch
    // actually included the full token list (not when the mode flipped mid-flight).
    const currentChainId = chainId.value
    const wasFullMode = fullBalancesRequesters.value > 0
    if (!currentChainId) {
      return
    }

    // Guard: the vault registry must hold vaults for THIS chain. Checking
    // `isReady` alone is not enough on chain switch: the registry can still
    // hold the previous chain's vaults until app.vue clears and reloads it.
    // `loadedChainId` is only set after a successful loadVaults() and cleared
    // to null on reset, so comparing it to the current chainId is the reliable
    // gate before asking the SDK wallet service for balances.
    if (loadedChainId.value !== currentChainId) {
      return
    }

    // Collect unique underlying asset addresses from ALL vaults (evk, earn, securitize)
    // plus external token list tokens for the swap selector
    // Note: We only fetch underlying token balances here, NOT vault share balances.
    // Share balances are fetched separately on individual pages via the SDK wallet service.
    const addresses = new Set<string>()
    const allVaults = [...getByType('evk'), ...getByType('earn'), ...getByType('securitize')]
    allVaults.forEach((vault) => {
      // Only add valid underlying asset addresses (not vault share addresses)
      if (vault.asset?.address && vault.asset.address.startsWith('0x') && vault.asset.address.length === 42) {
        try {
          addresses.add(getAddress(vault.asset.address))
        }
        catch {
          // Skip invalid addresses
        }
      }
    })

    // Include token list addresses (for swap selector zero-balance filtering)
    // ONLY when a page with the "pay with" selector is mounted. On mainnet
    // the token list is thousands of tokens, so including it in every
    // routine balance refresh stretches the fetch into many RPC chunks.
    // The main navigation pages (lend/borrow/earn) don't need this data,
    // so we default to vault-assets-only — typically a single RPC chunk.
    //
    // Pages that render SwapTokenSelector opt in via `useFullBalances()`; when
    // the counter flips from 0 we re-fire updateBalances to populate the rest.
    //
    // Defensive filter: only accept entries matching the active chain, so that
    // a stale useTokenList singleton from a previous chain can never contaminate
    // the RPC batch with foreign-chain addresses.
    if (fullBalancesRequesters.value > 0) {
      const { getAllTokens } = useTokenList()
      for (const token of getAllTokens()) {
        if (token.chainId !== currentChainId) continue
        try {
          addresses.add(getAddress(token.address))
        }
        catch {
          // Skip invalid addresses
        }
      }
    }

    // Always fetch the native (gas) balance via the SDK (zero address) so
    // `nativeBalance` is populated alongside the ERC20 balances.
    addresses.add(zeroAddress)
    const includesNativeCurrency = addresses.delete(zeroAddress)
    const tokenAddresses = [...addresses] as Address[]
    if (!tokenAddresses.length && !includesNativeCurrency) {
      isLoaded.value = true
      return
    }

    // Don't start new fetch if one is in progress
    if (isFetching.value) {
      return
    }

    isFetching.value = true

    try {
      const targetAddress = balanceAddress.value as Address
      const sdk = await getEulerSdkForChain(currentChainId)
      const assetsWithSpenders = tokenAddresses.map(asset => ({ asset, spenders: [] }))
      if (includesNativeCurrency) {
        assetsWithSpenders.push({ asset: zeroAddress, spenders: [] })
      }
      const walletFetch = await sdk.walletService.fetchWallet(currentChainId, targetAddress, assetsWithSpenders)
      if (walletFetch.errors.length) {
        logWarn('wallets/fetchBalances', 'wallet service returned diagnostics', {
          data: {
            chainId: currentChainId,
            target: targetAddress,
            errors: walletFetch.errors,
          },
        })
      }
      const wallet = walletFetch.result

      // Only update if still on the same chain and account.
      if (chainId.value === currentChainId && balanceAddress.value && getAddress(balanceAddress.value) === targetAddress) {
        // Merge rather than replace: a vault-only-mode fetch shouldn't drop
        // full-mode balances we fetched earlier (e.g. from a swap page).
        // resetBalances() is called on chain switch and wallet-address
        // change, which is the right boundary to fully clear.
        const merged = new Map(balances.value)
        for (const asset of wallet.assets) {
          merged.set(asset.asset, asset.balance)
        }
        balances.value = merged
        lastFetchChainId.value = currentChainId
        lastFetchAddress.value = targetAddress
        isLoaded.value = true
        if (wasFullMode) {
          lastFullFetchKey = `${currentChainId}:${targetAddress.toLowerCase()}`
          lastFullFetchAt = Date.now()
        }
      }
    }
    catch (e) {
      logWarn('wallets/fetchBalances', e)
      // Mark as loaded to avoid infinite retries
      if (chainId.value === currentChainId && !isLoaded.value) {
        isLoaded.value = true
        lastFetchChainId.value = currentChainId
      }
    }
    finally {
      isFetching.value = false
      fetchPromise = null
      // If dependencies changed while we were fetching, schedule a follow-up run
      if (needsFetch()) {
        fetchPromise = updateBalances()
      }
    }
  }

  // Check if we need to fetch on each call
  const needsFetch = () => {
    return (isConnected.value || isSpyMode.value)
      && loadedChainId.value === chainId.value
      && !!balanceAddress.value
      && (lastFetchChainId.value !== chainId.value || !isLoaded.value || lastFetchAddress.value !== balanceAddress.value)
      && !isFetching.value
  }

  // Trigger fetch if needed (deduped via fetchPromise)
  if (needsFetch() && !fetchPromise) {
    fetchPromise = updateBalances()
  }

  // Retry when dependencies become ready (e.g. vaults load after cold start).
  // Watching loadedChainId (instead of the less-specific isReady) ensures we
  // only fire once the registry is confirmed to hold vaults for the active chain.
  watch([loadedChainId, () => balanceAddress.value], () => {
    if (needsFetch() && !fetchPromise) {
      fetchPromise = updateBalances()
    }
  })

  const resetBalances = () => {
    balances.value = new Map()
    lastFullFetchKey = null
    lastFullFetchAt = 0
    isLoaded.value = false
    isFetching.value = false
    lastFetchChainId.value = null
    lastFetchAddress.value = null
    fetchPromise = null
  }

  const getBalance = (tokenAddress: Address): bigint => {
    let real: bigint
    try {
      real = balances.value.get(getAddress(tokenAddress)) || 0n
    }
    catch {
      real = balances.value.get(tokenAddress) || 0n
    }
    return applyLayerOverlay(tokenAddress, real)
  }

  // SDK-sourced native (gas) balance, reactive + layer-aware. `updateBalances`
  // always requests the zero address, so this reflects the connected/spy
  // wallet's native balance (was previously a separate wagmi `useBalance`).
  const nativeBalance = computed(() => getBalance(zeroAddress))

  /**
   * Resolve a single token's balance via the SDK wallet service and merge it
   * into the central wallet entity, so `getBalance(token)` (reactive, layer-
   * aware) reflects it afterwards. Reserved for arbitrary/custom swap tokens the
   * routine `updateBalances` sweep doesn't cover — known vault assets and
   * positions/shares are read from the wallet/account entities directly. Returns
   * the layer-aware balance.
   */
  const fetchSingleBalance = async (tokenAddress: string): Promise<bigint> => {
    if ((!isConnected.value && !isSpyMode.value) || !balanceAddress.value || !tokenAddress) {
      return 0n
    }
    try {
      const normalized = getAddress(tokenAddress)
      // Capture the chain id once so the SDK backend selection and the fetch
      // can't diverge if the user switches chains mid-await.
      const targetChainId = chainId.value
      if (!targetChainId) return 0n
      const sdk = await getEulerSdkForChain(targetChainId)
      const walletFetch = await sdk.walletService.fetchWallet(targetChainId, balanceAddress.value as Address, [
        { asset: normalized as Address, spenders: [] },
      ])
      const real = walletFetch.result.getBalance(normalized as Address)
      // Feed the central wallet entity so getBalance() sees this token too.
      const merged = new Map(balances.value)
      merged.set(normalized, real)
      balances.value = merged
      return applyLayerOverlay(normalized, real)
    }
    catch {
      return 0n
    }
  }

  // isLoading is true during initial load (and during the "waiting for the
  // active chain's vaults to finish loading" window that precedes it), but
  // stays false during background refreshes. Including the loadedChainId
  // check prevents the UI from flashing "0" balances between resetBalances()
  // and the actual fetch firing on chain switch — because updateBalances is
  // gated on loadedChainId === chainId, there's a real window where neither
  // isLoaded nor isFetching is true yet, and the balances Map is empty.
  const isLoading = computed(() =>
    !isLoaded.value && (isFetching.value || loadedChainId.value !== chainId.value),
  )

  return {
    balances,
    isLoaded,
    isLoading,
    getBalance,
    nativeBalance,
    updateBalances,
    resetBalances,
    fetchSingleBalance,
  }
}

/**
 * Opt the current component into "full balance" mode. While any component
 * using this is mounted, updateBalances includes the whole token list (so
 * the pay-with selector sees non-zero balances on wallet tokens); when the
 * counter returns to zero, subsequent updates go back to the vault-assets-
 * only fast path.
 *
 * Refcounted so multiple concurrent pages (unlikely, but safe) compose.
 * A TTL guard skips the re-fetch when navigating between two swap pages
 * within a 60s window on the same chain+address — the balances Map already
 * has them from the previous page's fetch, and the merge semantics in
 * updateBalances mean they weren't wiped by intervening vault-only fetches.
 *
 * Call once at `<script setup>` top-level — lifecycle hooks do the rest.
 */
export const useFullBalances = (): void => {
  const { updateBalances } = useWallets()
  const { chainId } = useEulerAddresses()
  const { address } = useWagmi()
  const { spyAddress, isSpyMode } = useSpyMode()

  onMounted(() => {
    fullBalancesRequesters.value++
    if (fullBalancesRequesters.value !== 1) return // not the first requester, data already in-flight / present

    const activeAddress = (isSpyMode.value ? spyAddress.value : address.value) ?? ''
    const expectedKey = `${chainId.value}:${activeAddress.toLowerCase()}`
    const isFresh = lastFullFetchKey === expectedKey && (Date.now() - lastFullFetchAt) < FULL_BALANCES_TTL_MS

    if (!isFresh) {
      void updateBalances()
    }
  })

  onBeforeUnmount(() => {
    fullBalancesRequesters.value = Math.max(0, fullBalancesRequesters.value - 1)
  })
}
