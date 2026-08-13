import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { getAddress, isAddress, type Address, type PublicClient } from 'viem'
import { governableGovernorAbi } from '~/abis/oracle'
import { createOnchainLookupCache } from '~/utils/onchain-lookup-cache'
import { isTransportError } from '~/utils/viem-errors'

// Router governance changes rarely; 5 min matches the app's other caches.
const CACHE_TTL_MS = 5 * 60_000

const governorCache = createOnchainLookupCache<Address | null>(CACHE_TTL_MS)

const probeGovernor = async (
  client: PublicClient,
  router: Address,
): Promise<Address | null> => {
  try {
    const governor = await client.readContract({
      address: router,
      abi: governableGovernorAbi,
      functionName: 'governor',
      authorizationList: undefined,
    })
    return getAddress(governor)
  }
  catch (err) {
    // A flaky RPC response must not get cached as "no governor" for the TTL.
    if (isTransportError(err)) throw err
    // Not a Governable contract (or empty call data) — no governor to show.
    return null
  }
}

/**
 * Reactive `governor()` lookup for an EulerRouter address.
 *
 * `governor` stays `undefined` until resolved; a resolved `null` means the
 * contract has no readable governor (don't render a row). The zero address is
 * passed through — it means governance was renounced, which is worth showing.
 */
export const useOracleRouterGovernor = (
  routerAddress: MaybeRefOrGetter<string | null | undefined>,
) => {
  const { chainId } = useEulerAddresses()
  const { client } = useRpcClient()

  const probeAddress = computed<Address | null>(() => {
    const value = toValue(routerAddress)
    if (!value || !isAddress(value)) return null
    return getAddress(value)
  })

  const cacheKey = computed(() => {
    if (!probeAddress.value || !chainId.value) return null
    return `${chainId.value}:${probeAddress.value.toLowerCase()}`
  })

  watch(
    [cacheKey, client],
    ([key, rpcClient]) => {
      // Probe client-side only — SSR output renders without the row and
      // hydrates identically (the client cache starts empty too).
      if (import.meta.server) return
      const target = probeAddress.value
      if (!key || !rpcClient || !target) return
      governorCache.load(key, () => probeGovernor(rpcClient, target)).catch(() => {})
    },
    { immediate: true },
  )

  const governor = computed<Address | null | undefined>(() => {
    if (!cacheKey.value) return undefined
    return governorCache.read(cacheKey.value)
  })

  return { governor }
}
