import type { OracleAdapterMetadata } from '@eulerxyz/euler-v2-sdk'
import { toReactive } from '@vueuse/core'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { type OracleAdapterMeta, normalizeOracleAdapterCheckSeverity } from '~/entities/oracle'

const oracleAdaptersRef = shallowRef<Record<string, OracleAdapterMeta>>({})
const oracleAdaptersChainId = ref<number | null>(null)
const pendingOracleAdapterLoads = new Map<number, Promise<Record<string, OracleAdapterMeta>>>()

const toOracleAdapterMeta = (metadata: OracleAdapterMetadata): OracleAdapterMeta => ({
  oracle: metadata.oracle,
  base: metadata.base,
  quote: metadata.quote,
  name: typeof metadata.name === 'string' ? metadata.name : undefined,
  provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
  methodology: typeof metadata.methodology === 'string' ? metadata.methodology : undefined,
  label: typeof metadata.label === 'string' ? metadata.label : undefined,
  checks: metadata.checks?.map(check => ({
    id: typeof check.id === 'string' ? check.id : '',
    message: typeof check.message === 'string' ? check.message : '',
    pass: check.pass === true,
    severity: normalizeOracleAdapterCheckSeverity(check.severity),
  })),
})

const normalizeOracleAdapterMap = (
  map: Record<string, OracleAdapterMetadata>,
): Record<string, OracleAdapterMeta> => Object.fromEntries(
  Object.values(map).map((metadata) => {
    const meta = toOracleAdapterMeta(metadata)
    return [meta.oracle.toLowerCase(), meta]
  }),
)

const loadAllOracleAdapters = async (chainId: number): Promise<void> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return

  // The dataset is fetched whole per chain, so once it's loaded a lookup miss
  // means the adapter genuinely isn't in it — reloading cannot surface it and
  // would replace oracleAdaptersRef with a fresh object, re-triggering every
  // subscriber (see the loadOracleAdapter miss path, which lands here on each
  // call for an unlisted adapter).
  if (oracleAdaptersChainId.value === chainId) return

  const inflight = pendingOracleAdapterLoads.get(chainId)
  if (inflight) {
    await inflight
    return
  }

  const promise = (async () => {
    const sdk = await getEulerSdk()
    const map = normalizeOracleAdapterMap(await sdk.oracleAdapterService.fetchOracleAdapterMap(chainId))
    oracleAdaptersRef.value = map
    oracleAdaptersChainId.value = chainId
    return map
  })()

  pendingOracleAdapterLoads.set(chainId, promise)
  try {
    await promise
  }
  catch (err) {
    logWarn('useEulerOracleAdapters', `Failed to load oracle adapters for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
  }
  finally {
    pendingOracleAdapterLoads.delete(chainId)
  }
}

const loadOracleAdapter = async (chainId: number, oracleAddress: string) => {
  const key = normalizeAddress(oracleAddress).toLowerCase()
  if (oracleAdaptersChainId.value === chainId && oracleAdaptersRef.value[key]) {
    return oracleAdaptersRef.value[key]
  }

  await loadAllOracleAdapters(chainId)
  return oracleAdaptersChainId.value === chainId ? oracleAdaptersRef.value[key] : undefined
}

const loadOracleAdapters = async (chainId: number, addresses?: string[]) => {
  if (!addresses?.length) return
  await Promise.all(addresses.map(addr => loadOracleAdapter(chainId, addr)))
}

// Module-level singleton: toReactive() wraps the computed in reactive(), whose
// isReadonly() probe reads a property through the proxy — a reactive read of
// the computed at construction time. Built per-call inside useEulerOracleAdapters,
// that read would subscribe whatever effect is currently running (e.g. a computed
// that reaches useEulerLabels() mid-evaluation) to oracleAdaptersRef, coupling
// unrelated reactive state to oracle-adapter loads. Constructing it once at
// module init (no active effect) keeps the subscription surface to actual readers.
const oracleAdapters = toReactive(computed(() => oracleAdaptersRef.value))

export const useEulerOracleAdapters = () => ({
  oracleAdapters,
  loadOracleAdapter,
  loadOracleAdapters,
  loadAllOracleAdapters,
})
