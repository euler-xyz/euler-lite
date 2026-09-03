import type { OracleAdapterAssessment } from '@eulerxyz/euler-v2-sdk'
import { toReactive } from '@vueuse/core'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useV3ChainGate } from '~/composables/useV3ChainGate'
import {
  type OracleAdapterCheckOutcome,
  type OracleAdapterMeta,
  normalizeOracleAdapterCheckSeverity,
} from '~/entities/oracle'

// How long a whole-chain catalogue load keeps answering single-adapter lookups
// before they go back to the SDK. Matches the SDK's own assessment cache window.
const ORACLE_ADAPTER_CATALOGUE_FRESH_MS = 5 * 60 * 1000

export type OracleAssessmentsStatus = 'idle' | 'loading' | 'available' | 'unavailable'

const oracleAdaptersRef = shallowRef<Record<string, OracleAdapterMeta>>({})
const oracleAssessmentsStatusRef = ref<OracleAssessmentsStatus>('idle')
const oracleAdaptersChainId = ref<number | null>(null)
// Retain per-chain display state, but let the SDK own bounded result freshness.
// Only concurrent requests are deduplicated here; later loads re-enter the SDK.
const oracleAdaptersByChain = new Map<number, Record<string, OracleAdapterMeta>>()
const oracleAssessmentsStatusByChain = new Map<number, OracleAssessmentsStatus>()
const oracleAdapterCatalogueLoadedAt = new Map<number, number>()
const oracleAdapterCatalogueKeys = new Map<number, Set<string>>()
type OracleAdapterLoadResult = {
  meta?: OracleAdapterMeta
  backendAvailable: boolean
}
const pendingOracleAdapterLoads = new Map<string, Promise<OracleAdapterLoadResult>>()
const pendingOracleAdapterListLoads = new Map<number, Promise<Record<string, OracleAdapterMeta>>>()

const toOptionalAddress = (value: unknown) =>
  typeof value === 'string' ? normalizeAddress(value) : undefined

const isAssessmentForRequest = (
  assessment: OracleAdapterAssessment,
  chainId: number,
  key: string,
) => assessment.chainId === chainId && assessment.address.toLowerCase() === key

const toOracleAdapterMeta = (assessment: OracleAdapterAssessment): OracleAdapterMeta => ({
  oracle: normalizeAddress(assessment.address),
  base: toOptionalAddress(assessment.config?.base),
  quote: toOptionalAddress(assessment.config?.quote),
  name: assessment.adapterClass ?? undefined,
  provider: assessment.provider ?? undefined,
  methodology: assessment.methodology ?? undefined,
  label: assessment.label ?? undefined,
  model: assessment.model ?? undefined,
  recognized: assessment.recognized,
  checksStatus: assessment.checksStatus,
  reason: assessment.reason ?? undefined,
  inActiveRoute: assessment.inActiveRoute,
  // `id` stays the stable V3 rule key; the display title is derived at render
  // time (see formatOracleCheckTitle).
  checks: assessment.findings.map(finding => ({
    id: finding.key,
    message: finding.description,
    outcome: finding.outcome as OracleAdapterCheckOutcome,
    severity: normalizeOracleAdapterCheckSeverity(finding.severity),
    expected: finding.expected,
    observed: finding.observed,
  })),
  summary: assessment.summary ?? undefined,
  policyId: assessment.policyId ?? undefined,
  policyVersion: assessment.policyVersion ?? undefined,
  blockNumber: assessment.blockNumber ?? undefined,
  evaluatedAt: assessment.evaluatedAt ?? undefined,
  lastCheckedAt: assessment.lastCheckedAt ?? undefined,
})

const normalizeOracleAdapterMap = (
  assessments: OracleAdapterAssessment[],
): Record<string, OracleAdapterMeta> => Object.fromEntries(
  assessments.map((assessment) => {
    const meta = toOracleAdapterMeta(assessment)
    return [meta.oracle.toLowerCase(), meta]
  }),
)

const activateChain = (chainId: number) => {
  if (oracleAdaptersChainId.value === chainId) return
  oracleAdaptersChainId.value = chainId
  oracleAdaptersRef.value = oracleAdaptersByChain.get(chainId) ?? {}
  oracleAssessmentsStatusRef.value = oracleAssessmentsStatusByChain.get(chainId) ?? 'idle'
}

const setAssessmentsStatus = (chainId: number, status: OracleAssessmentsStatus) => {
  oracleAssessmentsStatusByChain.set(chainId, status)
  if (oracleAdaptersChainId.value === chainId) oracleAssessmentsStatusRef.value = status
}

const setAssessmentsAvailable = (chainId: number, available: boolean) =>
  setAssessmentsStatus(chainId, available ? 'available' : 'unavailable')

// Keep already-rendered assessment data visible while it revalidates. Loading
// is an initial/retry state, not a reason to flash established content away.
const markAssessmentsLoading = (chainId: number) => {
  if (oracleAssessmentsStatusByChain.get(chainId) !== 'available') {
    setAssessmentsStatus(chainId, 'loading')
  }
}

const setAdapterMap = (chainId: number, map: Record<string, OracleAdapterMeta>) => {
  oracleAdaptersByChain.set(chainId, map)
  if (oracleAdaptersChainId.value === chainId) oracleAdaptersRef.value = map
}

const removeAdapter = (chainId: number, key: string) => {
  const current = oracleAdaptersByChain.get(chainId)
  if (!current || !Object.hasOwn(current, key)) return
  setAdapterMap(chainId, Object.fromEntries(
    Object.entries(current).filter(([address]) => address !== key),
  ))
}

const isV3EnabledForChain = (chainId: number): boolean =>
  useV3ChainGate().isV3EnabledForChain(chainId)

const applyCatalogue = (chainId: number, assessments: OracleAdapterAssessment[]) => {
  if (assessments.some(assessment => assessment.chainId !== chainId)) {
    throw new Error(`Oracle adapter catalogue contained an assessment for another chain than ${chainId}`)
  }
  const catalogueMap = normalizeOracleAdapterMap(assessments)
  const previousCatalogueKeys = oracleAdapterCatalogueKeys.get(chainId) ?? new Set<string>()
  const previous = oracleAdaptersByChain.get(chainId) ?? {}
  // The active-route catalogue is not the full assessment set. Keep only
  // entries loaded through the per-address path so catalogue refreshes cannot
  // blank fallback or inactive adapters that are still mounted.
  const extras = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !previousCatalogueKeys.has(key)),
  )
  setAdapterMap(chainId, { ...extras, ...catalogueMap })
  oracleAdapterCatalogueKeys.set(chainId, new Set(Object.keys(catalogueMap)))
  oracleAdapterCatalogueLoadedAt.set(chainId, Date.now())
}

const loadAllOracleAdapters = async (chainId: number): Promise<void> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return
  activateChain(chainId)
  if (!isV3EnabledForChain(chainId)) {
    setAssessmentsAvailable(chainId, false)
    return
  }

  markAssessmentsLoading(chainId)

  const inflight = pendingOracleAdapterListLoads.get(chainId)
  if (inflight) {
    await inflight
    return
  }

  const promise = (async () => {
    try {
      const sdk = await getEulerSdkForChain(chainId)
      // Only adapters in a live vault route. V3 derives `inActiveRoute` from the
      // full router state plus cross-adapter legs, which is exactly the set the
      // discovery matrix can render, and it skips the ~15% of rows that only
      // price deprecated or unreferenced vaults. Adapters reachable solely via a
      // router's fallback oracle are not flagged active; the per-address path in
      // loadOracleAdapter still resolves those on demand.
      const assessments = await sdk.oracleAdapterService.fetchOracleAdapterAssessments(chainId, { active: true })
      applyCatalogue(chainId, assessments)
      setAssessmentsAvailable(chainId, true)
      return oracleAdaptersByChain.get(chainId) ?? {}
    }
    catch (err) {
      setAssessmentsAvailable(chainId, false)
      logWarn('useEulerOracleAdapters', `Failed to load oracle adapter assessments for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
      return oracleAdaptersByChain.get(chainId) ?? {}
    }
  })()

  pendingOracleAdapterListLoads.set(chainId, promise)
  try {
    await promise
  }
  finally {
    pendingOracleAdapterListLoads.delete(chainId)
  }
}

// A whole-chain catalogue loaded within the freshness window already answers
// single-adapter lookups; skip the per-address request for hits. Misses still
// go to the SDK because the catalogue is filtered to active-route adapters.
const readFreshCatalogueEntry = (chainId: number, key: string): OracleAdapterMeta | undefined => {
  const loadedAt = oracleAdapterCatalogueLoadedAt.get(chainId)
  if (loadedAt === undefined || Date.now() - loadedAt > ORACLE_ADAPTER_CATALOGUE_FRESH_MS) return undefined
  if (!oracleAdapterCatalogueKeys.get(chainId)?.has(key)) return undefined
  return oracleAdaptersByChain.get(chainId)?.[key]
}

const loadOracleAdapterResult = async (
  chainId: number,
  oracleAddress: string,
): Promise<OracleAdapterLoadResult> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return { backendAvailable: false }
  activateChain(chainId)
  if (!isV3EnabledForChain(chainId)) {
    return { backendAvailable: false }
  }
  const address = normalizeAddress(oracleAddress)
  const key = address.toLowerCase()

  const catalogued = readFreshCatalogueEntry(chainId, key)
  if (catalogued) return { meta: catalogued, backendAvailable: true }

  const requestKey = `${chainId}:${key}`
  const inflight = pendingOracleAdapterLoads.get(requestKey)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const sdk = await getEulerSdkForChain(chainId)
      const assessment = await sdk.oracleAdapterService.fetchOracleAdapterAssessment(chainId, address)
      if (!assessment) {
        removeAdapter(chainId, key)
        return { backendAvailable: true }
      }
      if (!isAssessmentForRequest(assessment, chainId, key)) {
        throw new Error(`Oracle adapter assessment did not match chain ${chainId} adapter ${address}`)
      }
      const meta = toOracleAdapterMeta(assessment)
      setAdapterMap(chainId, {
        ...(oracleAdaptersByChain.get(chainId) ?? {}),
        [key]: meta,
      })
      return { meta, backendAvailable: true }
    }
    catch (err) {
      removeAdapter(chainId, key)
      logWarn('useEulerOracleAdapters', `Failed to load oracle adapter assessment ${address} on chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
      return { backendAvailable: false }
    }
  })()

  pendingOracleAdapterLoads.set(requestKey, promise)
  try {
    return await promise
  }
  finally {
    pendingOracleAdapterLoads.delete(requestKey)
  }
}

const loadOracleAdapter = async (chainId: number, oracleAddress: string) => {
  if (Number.isInteger(chainId) && chainId > 0) {
    activateChain(chainId)
    markAssessmentsLoading(chainId)
  }
  const result = await loadOracleAdapterResult(chainId, oracleAddress)
  if (Number.isInteger(chainId) && chainId > 0) {
    setAssessmentsAvailable(chainId, result.backendAvailable)
  }
  return result.meta
}

const loadOracleAdapters = async (chainId: number, addresses?: string[]) => {
  if (!addresses?.length) {
    if (Number.isInteger(chainId) && chainId > 0) activateChain(chainId)
    return
  }
  if (Number.isInteger(chainId) && chainId > 0) {
    activateChain(chainId)
    markAssessmentsLoading(chainId)
  }
  const results = await Promise.all(addresses.map(address => loadOracleAdapterResult(chainId, address)))
  setAssessmentsAvailable(chainId, results.every(result => result.backendAvailable))
}

// Module-level singleton: toReactive() wraps the computed in reactive(), whose
// isReadonly() probe reads a property through the proxy — a reactive read of
// the computed at construction time. Constructing it once with no active effect
// keeps the subscription surface limited to actual assessment readers.
const oracleAdapters = toReactive(computed(() => oracleAdaptersRef.value))
const oracleAssessmentsStatus = computed(() => oracleAssessmentsStatusRef.value)
const oracleAssessmentsAvailable = computed(() => oracleAssessmentsStatusRef.value === 'available')

export const useEulerOracleAdapters = () => ({
  oracleAdapters,
  oracleAssessmentsStatus,
  oracleAssessmentsAvailable,
  loadOracleAdapter,
  loadOracleAdapters,
  loadAllOracleAdapters,
})
