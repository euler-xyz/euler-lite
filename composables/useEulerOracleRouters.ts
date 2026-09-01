import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'

// Data V3 derives this set from indexed EulerRouter deployment and state
// events. Presence means the router is indexed as an Euler router; it is not a
// separate security assessment of every configured route.
const indexedRoutersRef = shallowRef<Set<string>>(new Set())
const indexedRoutersChainId = ref<number | null>(null)
// The SDK owns bounded result freshness; Lite only deduplicates concurrent loads.
const pendingRouterLoads = new Map<number, Promise<Set<string>>>()

const loadIndexedRouters = async (chainId: number): Promise<Set<string>> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return new Set()

  if (indexedRoutersChainId.value !== chainId) {
    indexedRoutersChainId.value = chainId
    indexedRoutersRef.value = new Set()
  }

  const inflight = pendingRouterLoads.get(chainId)
  if (inflight) return inflight

  const promise = (async () => {
    const sdk = await getEulerSdk()
    const routers = await sdk.oracleAdapterService.fetchOracleRouters(chainId)
    const set = new Set(routers.map(router => router.router.toLowerCase()))
    if (indexedRoutersChainId.value === chainId) {
      indexedRoutersRef.value = set
    }
    return set
  })()

  pendingRouterLoads.set(chainId, promise)
  try {
    return await promise
  }
  catch (err) {
    logWarn('useEulerOracleRouters', `Failed to load indexed routers for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
    return new Set()
  }
  finally {
    pendingRouterLoads.delete(chainId)
  }
}

export const useEulerOracleRouters = () => ({
  indexedRouters: computed(() => indexedRoutersRef.value),
  indexedRoutersChainId: readonly(indexedRoutersChainId),
  loadIndexedRouters,
})
