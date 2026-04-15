import { type Address, getAddress, zeroAddress } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { eulerUtilsLensABI } from '~/entities/euler/abis'
import { erc20BalanceOfAbi } from '~/abis/erc20'
import { logWarn } from '~/utils/errorHandling'
import { getPublicClient } from '~/utils/public-client'

// Singleton state
const balances = shallowRef(new Map<string, bigint>())
const isLoaded = ref(false)
const isFetching = ref(false)
const lastFetchChainId = ref<number | null>(null)
const lastFetchAddress = ref<string | null>(null)
let fetchPromise: Promise<void> | null = null

export const useWallets = () => {
  const { loadedChainId } = useVaults()
  const { getByType } = useVaultRegistry()
  const { address, isConnected } = useWagmi()
  const { eulerLensAddresses } = useEulerAddresses()
  const { chainId } = useEulerAddresses()
  const { rpcUrl } = useRpcClient()

  const { spyAddress, isSpyMode } = useSpyMode()
  const balanceAddress = computed(() =>
    isSpyMode.value ? spyAddress.value : address.value,
  )

  const updateBalances = async () => {
    // Guard: must be connected or in spy mode
    if (!balanceAddress.value || (!isConnected.value && !isSpyMode.value)) {
      return
    }

    // Capture chainId up-front so we can (a) filter out stale cross-chain
    // token-list entries and (b) discard results if the chain changes mid-fetch.
    const currentChainId = chainId.value

    // Guard: the vault registry must hold vaults for THIS chain. Checking
    // `isReady` alone is not enough — on chain switch, `eulerLensAddresses`
    // recomputes to the new chain's lens synchronously, which can trigger
    // our watcher *before* app.vue's chainId watcher has run
    // resetVaultsState(). In that window `isReady` is still true (from the
    // previous chain) and the registry still holds the previous chain's
    // vaults, which would be sent cross-chain to the new chain's lens.
    // `loadedChainId` is only set to the actual loaded chain after a
    // successful loadVaults() and cleared to null on reset, so comparing
    // it to the current chainId is the reliable gate.
    if (loadedChainId.value !== currentChainId) {
      return
    }

    // Guard: need lens address
    const utilsLensAddress = eulerLensAddresses.value?.utilsLens as Address
    if (!utilsLensAddress) {
      return
    }

    // Collect unique underlying asset addresses from ALL vaults (evk, earn, securitize)
    // plus external token list tokens for the swap selector
    // Note: We only fetch underlying token balances, NOT vault share balances
    // Share balances are fetched separately on individual pages via account lens
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

    // Include token list addresses (for swap selector zero-balance filtering).
    // Defensive filter: only accept entries matching the active chain, so that
    // a stale useTokenList singleton from a previous chain can never contaminate
    // the RPC batch with foreign-chain addresses.
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

    const tokenAddresses = [...addresses] as Address[]
    if (!tokenAddresses.length) {
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
      const client = getPublicClient(rpcUrl.value)

      // Fetch balances via lens in chunks to stay within gas limits
      // All chunks fire concurrently so viem's HTTP transport batches them into fewer requests
      const LENS_BATCH_SIZE = 250
      const chunks: Address[][] = []
      for (let i = 0; i < tokenAddresses.length; i += LENS_BATCH_SIZE) {
        chunks.push(tokenAddresses.slice(i, i + LENS_BATCH_SIZE))
      }

      const chunkResults = await Promise.all(
        chunks.map(async (batch, chunkIndex) => {
          try {
            return await client.readContract({
              address: utilsLensAddress,
              abi: eulerUtilsLensABI,
              functionName: 'tokenBalances',
              args: [targetAddress, batch],
            }) as bigint[]
          }
          catch (e) {
            logWarn(
              'wallets/batchFetch',
              `Lens tokenBalances failed, using zero fallback`,
              {
                data: {
                  chainId: currentChainId,
                  lens: utilsLensAddress,
                  target: targetAddress,
                  totalTokens: tokenAddresses.length,
                  chunkIndex,
                  chunkCount: chunks.length,
                  chunkSize: batch.length,
                  sampleTokens: batch.slice(0, 3),
                  error: e,
                },
              },
            )
            return batch.map(() => 0n)
          }
        }),
      )
      const result = chunkResults.flat()

      // Only update if still on same chain
      if (chainId.value === currentChainId) {
        const newBalances = new Map<string, bigint>()
        result.forEach((balance: bigint, index: number) => {
          newBalances.set(tokenAddresses[index], balance)
        })
        balances.value = newBalances
        lastFetchChainId.value = currentChainId
        lastFetchAddress.value = targetAddress
        isLoaded.value = true
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
      && !!eulerLensAddresses.value?.utilsLens
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
  watch([loadedChainId, () => balanceAddress.value, () => eulerLensAddresses.value?.utilsLens], () => {
    if (needsFetch() && !fetchPromise) {
      fetchPromise = updateBalances()
    }
  })

  const resetBalances = () => {
    balances.value = new Map()
    isLoaded.value = false
    isFetching.value = false
    lastFetchChainId.value = null
    lastFetchAddress.value = null
    fetchPromise = null
  }

  const getBalance = (tokenAddress: Address): bigint => {
    try {
      const normalized = getAddress(tokenAddress)
      return balances.value.get(normalized) || 0n
    }
    catch {
      return balances.value.get(tokenAddress) || 0n
    }
  }

  /**
   * Fetch a single token balance directly via balanceOf.
   * Use this for supply/deposit pages to avoid triggering the full batch query.
   */
  const fetchSingleBalance = async (tokenAddress: string): Promise<bigint> => {
    if ((!isConnected.value && !isSpyMode.value) || !balanceAddress.value || !tokenAddress) {
      return 0n
    }
    try {
      const client = getPublicClient(rpcUrl.value)
      const normalized = getAddress(tokenAddress)
      if (normalized === zeroAddress) {
        return await client.getBalance({ address: balanceAddress.value as Address })
      }
      const result = await client.readContract({
        address: normalized as Address,
        abi: erc20BalanceOfAbi,
        functionName: 'balanceOf',
        args: [balanceAddress.value as Address],
      }) as bigint
      return result
    }
    catch {
      return 0n
    }
  }

  /**
   * Fetch vault share balance via balanceOf on the vault address.
   * Use this for savings/deposit positions where user holds vault shares.
   */
  const fetchVaultShareBalance = async (vaultAddress: string, subAccount?: string): Promise<bigint> => {
    if ((!isConnected.value && !isSpyMode.value) || !balanceAddress.value || !vaultAddress) {
      return 0n
    }
    try {
      const balanceOfAddress = subAccount || balanceAddress.value
      const client = getPublicClient(rpcUrl.value)
      const result = await client.readContract({
        address: getAddress(vaultAddress) as Address,
        abi: erc20BalanceOfAbi,
        functionName: 'balanceOf',
        args: [balanceOfAddress as Address],
      }) as bigint
      return result
    }
    catch {
      return 0n
    }
  }

  // isLoading only true on initial load, not on background refreshes
  const isLoading = computed(() => !isLoaded.value && isFetching.value)

  return {
    balances,
    isLoaded,
    isLoading,
    getBalance,
    updateBalances,
    resetBalances,
    fetchSingleBalance,
    fetchVaultShareBalance,
  }
}
