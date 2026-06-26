import { logWarn } from '~/utils/errorHandling'

// Recognized EulerRouter addresses (deployed by the recognized EulerRouterFactory)
// are published per chain at `{oracle-checks}/{chainId}/routers/all.json` as a flat
// array of addresses. We proxy + cache them through `/api/oracle-routers` and keep a
// lowercased Set per chain so router-recognition lookups are O(1).
const recognizedRoutersRef = shallowRef<Set<string>>(new Set())
const recognizedRoutersChainId = ref<number | null>(null)
const pendingRouterLoads = new Map<number, Promise<Set<string>>>()

const toRecognizedSet = (data: unknown): Set<string> => {
  if (!Array.isArray(data)) return new Set()
  return new Set(
    data
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.toLowerCase()),
  )
}

const loadRecognizedRouters = async (chainId: number): Promise<Set<string>> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return new Set()

  if (recognizedRoutersChainId.value === chainId) {
    return recognizedRoutersRef.value
  }

  const inflight = pendingRouterLoads.get(chainId)
  if (inflight) return inflight

  const promise = (async () => {
    const data = await $fetch('/api/oracle-routers', { query: { chainId } })
    const set = toRecognizedSet(data)
    recognizedRoutersRef.value = set
    recognizedRoutersChainId.value = chainId
    return set
  })()

  pendingRouterLoads.set(chainId, promise)
  try {
    return await promise
  }
  catch (err) {
    logWarn('useEulerOracleRouters', `Failed to load recognized routers for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
    return new Set()
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
