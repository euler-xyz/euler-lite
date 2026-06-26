import { logWarn } from '~/utils/errorHandling'

// Recognised EulerRouter addresses (deployed by the recognised EulerRouterFactory)
// are published per chain at `{oracle-checks}/{chainId}/routers/all.json` as a flat
// array of addresses. We proxy + cache them through `/api/oracle-routers` and keep a
// lowercased Set per chain so router-recognition lookups are O(1).
const recognisedRoutersRef = shallowRef<Set<string>>(new Set())
const recognisedRoutersChainId = ref<number | null>(null)
const pendingRouterLoads = new Map<number, Promise<Set<string>>>()

const toRecognisedSet = (data: unknown): Set<string> => {
  if (!Array.isArray(data)) return new Set()
  return new Set(
    data
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.toLowerCase()),
  )
}

const loadRecognisedRouters = async (chainId: number): Promise<Set<string>> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return new Set()

  if (recognisedRoutersChainId.value === chainId) {
    return recognisedRoutersRef.value
  }

  const inflight = pendingRouterLoads.get(chainId)
  if (inflight) return inflight

  const promise = (async () => {
    const data = await $fetch('/api/oracle-routers', { query: { chainId } })
    const set = toRecognisedSet(data)
    recognisedRoutersRef.value = set
    recognisedRoutersChainId.value = chainId
    return set
  })()

  pendingRouterLoads.set(chainId, promise)
  try {
    return await promise
  }
  catch (err) {
    logWarn('useEulerOracleRouters', `Failed to load recognised routers for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
    return new Set()
  }
  finally {
    pendingRouterLoads.delete(chainId)
  }
}

export const useEulerOracleRouters = () => ({
  recognisedRouters: computed(() => recognisedRoutersRef.value),
  recognisedRoutersChainId: readonly(recognisedRoutersChainId),
  loadRecognisedRouters,
})
