import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'

// Recognized EulerRouter addresses. Data V3's `/v3/oracles/routers` is built
// from indexed `EulerRouterFactory` deployments, so every router it lists was
// deployed by the recognized factory — the same set the legacy oracle-checks
// `routers/all.json` was generated from. Kept as a lowercased Set per chain so
// router-recognition lookups are O(1).
const recognizedRoutersRef = shallowRef<Set<string>>(new Set())
const recognizedRoutersChainId = ref<number | null>(null)
// The SDK owns bounded result freshness; Lite only deduplicates concurrent loads.
const pendingRouterLoads = new Map<number, Promise<Set<string>>>()

const loadRecognizedRouters = async (chainId: number): Promise<Set<string>> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return new Set()

  if (recognizedRoutersChainId.value !== chainId) {
    recognizedRoutersChainId.value = chainId
    recognizedRoutersRef.value = new Set()
  }

  const inflight = pendingRouterLoads.get(chainId)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const sdk = await getEulerSdk()
      const routers = await sdk.oracleAdapterService.fetchOracleRouters(chainId)
      // CREATE2 factory deployments reuse the same router address across chains.
      // Only count rows that actually belong to the requested chain.
      const set = new Set(
        routers
          .filter(router => router.chainId === chainId)
          .map(router => router.router.toLowerCase()),
      )
      if (recognizedRoutersChainId.value === chainId) {
        recognizedRoutersRef.value = set
      }
      return set
    }
    catch (err) {
      logWarn('useEulerOracleRouters', `Failed to load recognized routers for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
      return new Set()
    }
  })()

  pendingRouterLoads.set(chainId, promise)
  try {
    return await promise
  }
  finally {
    pendingRouterLoads.delete(chainId)
  }
}

export const useEulerOracleRouters = () => ({
  recognizedRouters: computed(() => recognizedRoutersRef.value),
  recognizedRoutersChainId: readonly(recognizedRoutersChainId),
  loadRecognizedRouters,
})
