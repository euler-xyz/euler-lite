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

const oracleAdaptersRef = shallowRef<Record<string, OracleAdapterMeta>>({})
const oracleAdaptersChainId = ref<number | null>(null)
const oracleAdaptersByChain = new Map<number, Record<string, OracleAdapterMeta>>()
const fullyLoadedChains = new Set<number>()
const loadedAdapterKeysByChain = new Map<number, Set<string>>()
const pendingOracleAdapterLoads = new Map<string, Promise<OracleAdapterMeta | undefined>>()
const pendingOracleAdapterListLoads = new Map<number, Promise<Record<string, OracleAdapterMeta>>>()

const toOptionalAddress = (value: unknown) =>
  typeof value === 'string' ? normalizeAddress(value) : undefined

const toOracleAdapterMeta = (assessment: OracleAdapterAssessment): OracleAdapterMeta => ({
  oracle: assessment.address,
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

const loadAllOracleAdapters = async (chainId: number): Promise<void> => {
  if (!Number.isInteger(chainId) || chainId <= 0) return
  activateChain(chainId)
  if (fullyLoadedChains.has(chainId)) return

  const inflight = pendingOracleAdapterListLoads.get(chainId)
  if (inflight) {
    await inflight
    return
  }

  const promise = (async () => {
    const sdk = await getEulerSdk()
    const assessments = await sdk.oracleAdapterService.fetchOracleAdapterAssessments(chainId)
    const map = normalizeOracleAdapterMap(assessments)
    oracleAdaptersByChain.set(chainId, map)
    loadedAdapterKeysByChain.set(chainId, new Set(Object.keys(map)))
    fullyLoadedChains.add(chainId)
    if (oracleAdaptersChainId.value === chainId) {
      oracleAdaptersRef.value = map
    }
    return map
  })()

  pendingOracleAdapterListLoads.set(chainId, promise)
  try {
    await promise
  }
  catch (err) {
    logWarn('useEulerOracleAdapters', `Failed to load oracle adapter assessments for chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
  }
  finally {
    pendingOracleAdapterListLoads.delete(chainId)
  }
}

const loadOracleAdapter = async (chainId: number, oracleAddress: string) => {
  if (!Number.isInteger(chainId) || chainId <= 0) return undefined
  activateChain(chainId)
  const address = normalizeAddress(oracleAddress)
  const key = address.toLowerCase()
  const loaded = oracleAdaptersRef.value[key]
  if (loaded) return loaded
  if (fullyLoadedChains.has(chainId)) return undefined
  if (loadedAdapterKeysByChain.get(chainId)?.has(key)) return undefined

  const requestKey = `${chainId}:${key}`
  const inflight = pendingOracleAdapterLoads.get(requestKey)
  if (inflight) return inflight

  const promise = (async () => {
    const sdk = await getEulerSdk()
    const assessment = await sdk.oracleAdapterService.fetchOracleAdapterAssessment(chainId, address)
    const loadedKeys = loadedAdapterKeysByChain.get(chainId) ?? new Set<string>()
    loadedKeys.add(key)
    loadedAdapterKeysByChain.set(chainId, loadedKeys)
    if (!assessment) return undefined
    const meta = toOracleAdapterMeta(assessment)
    const chainMap = {
      ...(oracleAdaptersByChain.get(chainId) ?? {}),
      [key]: meta,
    }
    oracleAdaptersByChain.set(chainId, chainMap)
    if (oracleAdaptersChainId.value === chainId) {
      oracleAdaptersRef.value = chainMap
    }
    return meta
  })()

  pendingOracleAdapterLoads.set(requestKey, promise)
  try {
    return await promise
  }
  catch (err) {
    logWarn('useEulerOracleAdapters', `Failed to load oracle adapter assessment ${address} on chain ${chainId}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  finally {
    pendingOracleAdapterLoads.delete(requestKey)
  }
}

const loadOracleAdapters = async (chainId: number, addresses?: string[]) => {
  if (!addresses?.length) return
  await Promise.all(addresses.map(addr => loadOracleAdapter(chainId, addr)))
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
