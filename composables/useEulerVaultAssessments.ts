import { isVaultAssessmentUnavailableError, parseVaultAssessment, type VaultAssessment, type VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { computed, shallowRef, ref } from 'vue'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useV3ChainGate } from '~/composables/useV3ChainGate'
import { getChainPolicyGeneration, subscribeToChainPolicyChanges } from '~/composables/useChainConfig'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { advanceSdkQueryGeneration } from '~/utils/sdk-query-cache'

export type VaultAssessmentsStatus = 'idle' | 'loading' | 'available' | 'unavailable'
type VaultAssessmentEntry = {
  status: VaultAssessmentsStatus
  assessment?: VaultAssessment
  consistencyStatus?: string | null
}

type AssessmentService = {
  fetchVaultAssessment: (chainId: number, address: Address, family: VaultAssessmentFamily, options?: { fresh?: boolean }) => Promise<VaultAssessment | undefined>
  queryV3VaultAssessment?: (chainId: number, address: Address, family: VaultAssessmentFamily) => Promise<unknown>
}

const readRawConsistencyStatus = (raw: unknown): string | null => {
  const status = raw && typeof raw === 'object' ? (raw as { consistencyStatus?: unknown }).consistencyStatus : undefined
  return typeof status === 'string' ? status : null
}

/**
 * The SDK's parsed assessment drops `consistencyStatus`, so both come from one raw body. A fresh read starts
 * a new query generation first, which later cached reads then share.
 */
const fetchAssessment = async (
  service: AssessmentService,
  chainId: number,
  address: Address,
  family: VaultAssessmentFamily,
  fresh: boolean,
): Promise<Pick<VaultAssessmentEntry, 'assessment' | 'consistencyStatus'>> => {
  if (typeof service.queryV3VaultAssessment !== 'function') {
    return { assessment: await service.fetchVaultAssessment(chainId, address, family, { fresh }), consistencyStatus: null }
  }
  if (fresh) await advanceSdkQueryGeneration(['queryV3VaultAssessment'])
  const raw = await service.queryV3VaultAssessment(chainId, address, family)
  if (raw === undefined) return { assessment: undefined, consistencyStatus: null }
  return { assessment: parseVaultAssessment(raw, chainId, address, family), consistencyStatus: readRawConsistencyStatus(raw) }
}

const activeChainId = ref<number | null>(null)
const entriesByChain = shallowRef<Record<number, Record<string, VaultAssessmentEntry>>>({})
const entries = computed(() => activeChainId.value === null ? {} : entriesByChain.value[activeChainId.value] ?? {})
const unsupportedChainIds = shallowRef<Set<number>>(new Set())
const pending = new Map<string, Promise<VaultAssessmentEntry>>()
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>()
const REFRESH_INTERVAL_MS = 20_000
const REFRESH_WINDOW_MS = 2 * 60_000

subscribeToChainPolicyChanges((chainId) => {
  entriesByChain.value = Object.fromEntries(Object.entries(entriesByChain.value).filter(([id]) => Number(id) !== chainId))
  unsupportedChainIds.value = new Set([...unsupportedChainIds.value].filter(id => id !== chainId))
  for (const key of pending.keys()) {
    if (key.startsWith(`${chainId}:`)) pending.delete(key)
  }
  for (const [key, timer] of refreshTimers) {
    if (key.startsWith(`${chainId}:`)) {
      clearInterval(timer)
      refreshTimers.delete(key)
    }
  }
})

const activate = (chainId: number) => {
  if (activeChainId.value === chainId) return
  activeChainId.value = chainId
}
const keyFor = (family: VaultAssessmentFamily, address: string) =>
  `${family}:${normalizeAddress(address).toLowerCase()}`
const setEntry = (chainId: number, key: string, entry: VaultAssessmentEntry) => {
  const next = { ...(entriesByChain.value[chainId] ?? {}), [key]: entry }
  entriesByChain.value = { ...entriesByChain.value, [chainId]: next }
}

const isAvailableForChain = (chainId: number) =>
  useV3ChainGate().isV3EnabledForChain(chainId) && !unsupportedChainIds.value.has(chainId)

const loadVaultAssessment = async (
  chainId: number,
  address: string,
  family: VaultAssessmentFamily,
  options: { fresh?: boolean, background?: boolean } = {},
): Promise<VaultAssessmentEntry> => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAvailableForChain(chainId)) {
    return { status: 'idle' }
  }
  if (!options.background) activate(chainId)
  const normalized = normalizeAddress(address)
  const key = keyFor(family, normalized)
  const requestKey = `${chainId}:${key}`
  const inflight = pending.get(requestKey)
  if (inflight) return inflight
  const previous = entriesByChain.value[chainId]?.[key]
  if (!previous || previous.status !== 'available') setEntry(chainId, key, { status: 'loading' })
  const generation = getChainPolicyGeneration(chainId)
  const isCurrent = () => generation === getChainPolicyGeneration(chainId) && isAvailableForChain(chainId)
  const promise = (async (): Promise<VaultAssessmentEntry> => {
    try {
      const sdk = await getEulerSdkForChain(chainId)
      const { assessment, consistencyStatus } = await fetchAssessment(
        sdk.vaultAssessmentService as AssessmentService,
        chainId,
        normalized,
        family,
        !!options.fresh,
      )
      if (!isCurrent()) return { status: 'idle' }
      const entry: VaultAssessmentEntry = { status: 'available', assessment, consistencyStatus }
      setEntry(chainId, key, entry)
      return entry
    }
    catch (error) {
      if (!isCurrent()) return { status: 'idle' }
      if (isVaultAssessmentUnavailableError(error, 'chain-not-supported')) {
        unsupportedChainIds.value = new Set([...unsupportedChainIds.value, chainId])
      }
      const entry: VaultAssessmentEntry = { status: 'unavailable' }
      setEntry(chainId, key, entry)
      logWarn('useEulerVaultAssessments', `Failed to load assessment ${normalized} on chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`)
      return entry
    }
  })()
  pending.set(requestKey, promise)
  try {
    return await promise
  }
  finally {
    if (pending.get(requestKey) === promise) pending.delete(requestKey)
  }
}

const refreshAfterOwnTransaction = (chainId: number, address: string, family: VaultAssessmentFamily) => {
  if (!isAvailableForChain(chainId)) return
  const key = `${chainId}:${keyFor(family, address)}`
  const previous = refreshTimers.get(key)
  if (previous) clearInterval(previous)
  const stopAt = Date.now() + REFRESH_WINDOW_MS
  void loadVaultAssessment(chainId, address, family, { fresh: true, background: true })
  const timer = setInterval(() => {
    if (Date.now() >= stopAt) {
      clearInterval(timer)
      refreshTimers.delete(key)
      return
    }
    void loadVaultAssessment(chainId, address, family, { fresh: true, background: true })
  }, REFRESH_INTERVAL_MS)
  refreshTimers.set(key, timer)
}

export const useEulerVaultAssessments = () => ({
  entries,
  activeChainId,
  loadVaultAssessment,
  refreshAfterOwnTransaction,
  getEntry: (chainId: number, address: string, family: VaultAssessmentFamily): VaultAssessmentEntry =>
    entriesByChain.value[chainId]?.[keyFor(family, address)] ?? { status: 'idle' },
  isAvailableForChain,
})
