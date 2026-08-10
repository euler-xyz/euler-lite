import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { getAddress, isAddress, type Address, type PublicClient } from 'viem'
import { safeAccountAbi } from '~/abis/safe'
import { createOnchainLookupCache } from '~/utils/onchain-lookup-cache'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { isTransportError } from '~/utils/viem-errors'
import { resolveSafeAccountInfo, type SafeAccountInfo } from '~/utils/safe-account'

// Threshold/owners can change over time; 5 min matches the app's other caches.
const CACHE_TTL_MS = 5 * 60_000

const safeInfoCache = createOnchainLookupCache<SafeAccountInfo | null>(CACHE_TTL_MS)

/**
 * Probe whether an address is a Safe smart account.
 *
 * All three reads fire concurrently — the transport batches them into a
 * single RPC request. EOAs return empty call data and non-Safe contracts
 * revert on the unknown selectors, so those failures mean "not a Safe".
 * Transport-level failures are rethrown instead — a flaky RPC response must
 * not get cached as a definitive negative for the TTL.
 */
const probeSafeAccount = async (
  client: PublicClient,
  address: Address,
): Promise<SafeAccountInfo | null> => {
  const results = await Promise.allSettled([
    client.readContract({
      address,
      abi: safeAccountAbi,
      functionName: 'masterCopy',
      authorizationList: undefined,
    }),
    client.readContract({
      address,
      abi: safeAccountAbi,
      functionName: 'getThreshold',
      authorizationList: undefined,
    }),
    client.readContract({
      address,
      abi: safeAccountAbi,
      functionName: 'getOwners',
      authorizationList: undefined,
    }),
  ])

  for (const result of results) {
    if (result.status === 'rejected' && isTransportError(result.reason)) {
      throw result.reason
    }
  }

  const [masterCopy, threshold, owners] = results
  return resolveSafeAccountInfo(
    masterCopy.status === 'fulfilled' ? masterCopy.value : null,
    threshold.status === 'fulfilled' ? threshold.value : null,
    owners.status === 'fulfilled' ? owners.value : null,
  )
}

/**
 * Reactive Safe detection for a displayed address.
 *
 * `safeInfo` is `null` until the probe resolves positively — callers just
 * hide the badge for non-Safes, unknowns, and while loading. Probing runs
 * client-side only; results are cached per `${chainId}:${address}` across
 * component instances.
 */
export const useSafeAddressInfo = (
  address: MaybeRefOrGetter<string | null | undefined>,
) => {
  const { chainId } = useEulerAddresses()
  const { client } = useRpcClient()

  const probeAddress = computed<Address | null>(() => {
    const value = toValue(address)
    if (!value || !isAddress(value)) return null
    // Sentinel addresses (zero/USD/ETH/BTC) are never Safes — skip the probe.
    if (getSpecialAddressLabel(value)) return null
    return getAddress(value)
  })

  const cacheKey = computed(() => {
    if (!probeAddress.value || !chainId.value) return null
    return `${chainId.value}:${probeAddress.value.toLowerCase()}`
  })

  watch(
    [cacheKey, client],
    ([key, rpcClient]) => {
      // Probe client-side only — SSR output renders without badges and
      // hydrates identically (the client cache starts empty too).
      if (import.meta.server) return
      const target = probeAddress.value
      if (!key || !rpcClient || !target) return
      safeInfoCache.load(key, () => probeSafeAccount(rpcClient, target)).catch(() => {})
    },
    { immediate: true },
  )

  const safeInfo = computed<SafeAccountInfo | null>(() => {
    if (!cacheKey.value) return null
    return safeInfoCache.read(cacheKey.value) ?? null
  })

  return { safeInfo }
}
