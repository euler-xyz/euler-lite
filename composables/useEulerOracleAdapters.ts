import type { OracleAdapterAssessment } from '@eulerxyz/euler-v2-sdk'
import { toReactive } from '@vueuse/core'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { getEulerSdk } from '~/composables/useEulerSdk'
import {
  type OracleAdapterCheckOutcome,
  type OracleAdapterMeta,
  normalizeOracleAdapterCheckSeverity,
} from '~/entities/oracle'

// How long a whole-chain catalogue load keeps answering single-adapter lookups
// before they go back to the SDK. Matches the SDK's own assessment cache window.
const ORACLE_ADAPTER_CATALOGUE_FRESH_MS = 5 * 60 * 1000

const oracleAdaptersRef = shallowRef<Record<string, OracleAdapterMeta>>({})
const oracleAdaptersChainId = ref<number | null>(null)
// Retain per-chain display state, but let the SDK own bounded result freshness.
// Only concurrent requests are deduplicated here; later loads re-enter the SDK.
const oracleAdaptersByChain = new Map<number, Record<string, OracleAdapterMeta>>()
const oracleAdapterCatalogueLoadedAt = new Map<number, number>()
const oracleAdapterCatalogueKeys = new Map<number, Set<string>>()
const pendingOracleAdapterLoads = new Map<string, Promise<OracleAdapterMeta | undefined>>()
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
}

const applyChainMap = (chainId: number, map: Record<string, OracleAdapterMeta>) => {
  oracleAdaptersByChain.set(chainId, map)
  if (oracleAdaptersChainId.value === chainId) {
    oracleAdaptersRef.value = map
  }
}

const applyCatalogue = (chainId: number, assessments: OracleAdapterAssessment[]) => {
  const catalogueMap = normalizeOracleAdapterMap(
    assessments.filter(assessment => assessment.chainId === chainId),
  )
  const previous = oracleAdaptersByChain.get(chainId) ?? {}
  // The active-route catalogue is not the full assessment set. Keep per-address
  // extras (fallback oracles, inactive rows) so a later catalogue write cannot
  // blank a still-mounted overview that already resolved them.
  const extras = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !Object.hasOwn(catalogueMap, key)),
  )
  applyChainMap(chainId, { ...extras, ...catalogueMap })
  oracleAdapterCatalogueKeys.set(chainId, new Set(Object.keys(catalogueMap)))
  oracleAdapterCatalogueLoadedAt.set(chainId, Date.now())
}

const loadAllOracleAdapters = async (chainId: number): Promise<void> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return
  activateChain(chainId)

  const inflight = pendingOracleAdapterListLoads.get(chainId)
  if (inflight) {
    await inflight
    return
  }

  const promise = (async () => {
    try {
      const sdk = await getEulerSdk()
      // Only adapters in a live vault route. V3 derives `inActiveRoute` from the
      // full router state plus cross-adapter legs, which is exactly the set the
      // discovery matrix can render, and it skips the ~15% of rows that only
      // price deprecated or unreferenced vaults. Adapters reachable solely via a
      // router's fallback oracle are not flagged active; the per-address path in
      // loadOracleAdapter still resolves those on demand.
      const assessments = await sdk.oracleAdapterService.fetchOracleAdapterAssessments(chainId, { active: true })
      applyCatalogue(chainId, assessments)
      return oracleAdaptersByChain.get(chainId) ?? {}
    }
    catch (err) {
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

const loadOracleAdapter = async (chainId: number, oracleAddress: string) => {
  if (!Number.isInteger(chainId) || chainId <= 0) return undefined
  activateChain(chainId)
  const address = normalizeAddress(oracleAddress)
  const key = address.toLowerCase()

  const catalogued = readFreshCatalogueEntry(chainId, key)
  if (catalogued) return catalogued

  const requestKey = `${chainId}:${key}`
  const inflight = pendingOracleAdapterLoads.get(requestKey)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const sdk = await getEulerSdk()
      const assessment = await sdk.oracleAdapterService.fetchOracleAdapterAssessment(chainId, address)
      if (!assessment) {
        const currentMap = oracleAdaptersByChain.get(chainId)
        if (currentMap && Object.hasOwn(currentMap, key)) {
          applyChainMap(chainId, Object.fromEntries(
            Object.entries(currentMap).filter(([entryAddress]) => entryAddress !== key),
          ))
        }
        return undefined
      }
      if (!isAssessmentForRequest(assessment, chainId, key)) {
        logWarn('useEulerOracleAdapters', `Ignored oracle adapter assessment that did not match chain ${chainId} adapter ${address}`)
        return undefined
      }
      const meta = toOracleAdapterMeta(assessment)
      applyChainMap(chainId, {
        ...(oracleAdaptersByChain.get(chainId) ?? {}),
        [key]: meta,
      })
      return meta
    }
    catch (err) {
      logWarn('useEulerOracleAdapters', `Failed to load oracle adapter assessment ${address} on chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
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

const loadOracleAdapters = async (chainId: number, addresses?: string[]) => {
  if (!addresses?.length) return
  await Promise.all(addresses.map(address => loadOracleAdapter(chainId, address)))
}

// Module-level singleton: toReactive() wraps the computed in reactive(), whose
// isReadonly() probe reads a property through the proxy — a reactive read of
// the computed at construction time. Constructing it once with no active effect
// keeps the subscription surface limited to actual assessment readers.
const oracleAdapters = toReactive(computed(() => oracleAdaptersRef.value))

export const useEulerOracleAdapters = () => ({
  oracleAdapters,
  loadOracleAdapter,
  loadOracleAdapters,
  loadAllOracleAdapters,
})
