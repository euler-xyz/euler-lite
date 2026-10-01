import { isVaultAssessmentUnavailableError, type VaultAssessment, type VaultAssessmentFamily } from '@eulerxyz/euler-v2-sdk'
import { shallowRef, ref } from 'vue'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { useV3ChainGate } from '~/composables/useV3ChainGate'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'

export type VaultAssessmentsStatus = 'idle' | 'loading' | 'available' | 'unavailable'
type VaultAssessmentEntry = {
  status: VaultAssessmentsStatus
  assessment?: VaultAssessment
}

const entries = shallowRef<Record<string, VaultAssessmentEntry>>({})
const activeChainId = ref<number | null>(null)
const entriesByChain = new Map<number, Record<string, VaultAssessmentEntry>>()
const unsupportedChainIds = shallowRef<Set<number>>(new Set())
const pending = new Map<string, Promise<VaultAssessmentEntry>>()
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>()
const REFRESH_INTERVAL_MS = 20_000
const REFRESH_WINDOW_MS = 2 * 60_000

const activate = (chainId: number) => {
  if (activeChainId.value === chainId) return
  activeChainId.value = chainId
  entries.value = entriesByChain.get(chainId) ?? {}
}
const keyFor = (family: VaultAssessmentFamily, address: string) =>
  `${family}:${normalizeAddress(address).toLowerCase()}`
const setEntry = (chainId: number, key: string, entry: VaultAssessmentEntry) => {
  const next = { ...(entriesByChain.get(chainId) ?? {}), [key]: entry }
  entriesByChain.set(chainId, next)
  if (activeChainId.value === chainId) entries.value = next
}

const isAvailableForChain = (chainId: number) =>
  useV3ChainGate().isV3EnabledForChain(chainId) && !unsupportedChainIds.value.has(chainId)

const loadVaultAssessment = async (
  chainId: number,
  address: string,
  family: VaultAssessmentFamily,
  options: { fresh?: boolean } = {},
): Promise<VaultAssessmentEntry> => {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAvailableForChain(chainId)) {
    return { status: 'idle' }
  }
  activate(chainId)
  const normalized = normalizeAddress(address)
  const key = keyFor(family, normalized)
  const requestKey = `${chainId}:${key}`
  const inflight = pending.get(requestKey)
  if (inflight) return inflight
  const previous = entriesByChain.get(chainId)?.[key]
  if (!previous || previous.status !== 'available') setEntry(chainId, key, { status: 'loading' })
  const promise = (async (): Promise<VaultAssessmentEntry> => {
    try {
      const sdk = await getEulerSdkForChain(chainId)
      const assessment = await sdk.vaultAssessmentService.fetchVaultAssessment(chainId, normalized, family, options)
      const entry: VaultAssessmentEntry = { status: 'available', assessment }
      setEntry(chainId, key, entry)
      return entry
    }
    catch (error) {
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
    pending.delete(requestKey)
  }
}

const refreshAfterOwnTransaction = (chainId: number, address: string, family: VaultAssessmentFamily) => {
  if (!isAvailableForChain(chainId)) return
  const key = `${chainId}:${keyFor(family, address)}`
  const previous = refreshTimers.get(key)
  if (previous) clearInterval(previous)
  const stopAt = Date.now() + REFRESH_WINDOW_MS
  void loadVaultAssessment(chainId, address, family, { fresh: true })
  const timer = setInterval(() => {
    if (Date.now() >= stopAt) {
      clearInterval(timer)
      refreshTimers.delete(key)
      return
    }
    void loadVaultAssessment(chainId, address, family, { fresh: true })
  }, REFRESH_INTERVAL_MS)
  refreshTimers.set(key, timer)
}

export const useEulerVaultAssessments = () => ({
  entries,
  activeChainId,
  loadVaultAssessment,
  refreshAfterOwnTransaction,
  getEntry: (chainId: number, address: string, family: VaultAssessmentFamily): VaultAssessmentEntry =>
    entriesByChain.get(chainId)?.[keyFor(family, address)] ?? { status: 'idle' },
  isAvailableForChain,
})
