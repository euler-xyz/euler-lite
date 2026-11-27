import { V3_API_PROXY_URL } from '~/utils/api-url-env'
import {
  buildBadDebtCache,
  parseBadDebtResponse,
  type VaultBadDebtCacheEntry,
  type V3VaultBadDebtRow,
} from '~/utils/vault-bad-debt'

const badDebtByChain = shallowRef<Map<number, Map<string, VaultBadDebtCacheEntry>>>(new Map())
const loadingChains = shallowRef<Set<number>>(new Set())
const errorByChain = shallowRef<Map<number, Error>>(new Map())
const inFlight = new Map<number, Promise<void>>()
const failedAtByChain = new Map<number, number>()
const BAD_DEBT_RETRY_AFTER_MS = 60_000
const BAD_DEBT_TIMEOUT_MS = 15_000

const fetchJsonWithTimeout = async (url: string): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BAD_DEBT_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`Bad debt fetch failed with ${response.status}`)
    return await response.json()
  }
  finally {
    clearTimeout(timer)
  }
}

const setChainLoading = (chainId: number, loading: boolean) => {
  const next = new Set(loadingChains.value)
  if (loading) next.add(chainId)
  else next.delete(chainId)
  loadingChains.value = next
}

const setChainCache = (chainId: number, cache: Map<string, VaultBadDebtCacheEntry>) => {
  badDebtByChain.value = new Map([...badDebtByChain.value, [chainId, cache]])
}

const setChainError = (chainId: number, error: Error | null) => {
  const next = new Map(errorByChain.value)
  if (error) next.set(chainId, error)
  else next.delete(chainId)
  errorByChain.value = next
}

const buildBadDebtUrl = (baseUrl: string, chainId: number, offset: number, limit: number): string => {
  const base = baseUrl.replace(/\/+$/, '') || V3_API_PROXY_URL
  const params = new URLSearchParams({
    chainId: String(chainId),
    minBadDebtUsd: '0',
    offset: String(offset),
    limit: String(limit),
  })
  return `${base}/evk/vaults/bad-debt?${params.toString()}`
}

const fetchBadDebtRows = async (
  baseUrl: string,
  chainId: number,
): Promise<V3VaultBadDebtRow[]> => {
  const limit = 100
  let offset = 0
  const rows: V3VaultBadDebtRow[] = []

  while (true) {
    const body = await fetchJsonWithTimeout(buildBadDebtUrl(baseUrl, chainId, offset, limit))
    const page = parseBadDebtResponse(body)
    rows.push(...page)
    if (page.length < limit) return rows
    offset += limit
  }
}

export const useVaultBadDebt = () => {
  const { chainId } = useEulerAddresses()
  const envConfig = useEnvConfig()
  const { isV3EnabledForChain } = useV3ChainGate()
  const isBadDebtEnabled = computed(() => isV3EnabledForChain(chainId.value))

  const loadBadDebtForChain = async (
    targetChainId = chainId.value,
    { force = false }: { force?: boolean } = {},
  ) => {
    if (!isV3EnabledForChain(targetChainId)) {
      setChainLoading(targetChainId, false)
      setChainError(targetChainId, null)
      return
    }
    if (!force && badDebtByChain.value.has(targetChainId) && !errorByChain.value.has(targetChainId)) return
    const failedAt = failedAtByChain.get(targetChainId)
    if (!force && failedAt !== undefined && Date.now() - failedAt < BAD_DEBT_RETRY_AFTER_MS) return
    const existing = inFlight.get(targetChainId)
    if (existing) return existing

    const promise = (async () => {
      setChainLoading(targetChainId, true)
      setChainError(targetChainId, null)
      try {
        const rows = await fetchBadDebtRows(envConfig.v3ApiUrl, targetChainId)
        failedAtByChain.delete(targetChainId)
        setChainCache(targetChainId, buildBadDebtCache(rows))
      }
      catch (err) {
        failedAtByChain.set(targetChainId, Date.now())
        setChainError(targetChainId, err instanceof Error ? err : new Error(String(err)))
      }
      finally {
        setChainLoading(targetChainId, false)
        inFlight.delete(targetChainId)
      }
    })()

    inFlight.set(targetChainId, promise)
    return promise
  }

  const getVaultBadDebt = (
    vaultAddress: string,
    targetChainId = chainId.value,
  ): VaultBadDebtCacheEntry | undefined =>
    badDebtByChain.value.get(targetChainId)?.get(vaultAddress.toLowerCase())

  const isBadDebtLoading = computed(() => isBadDebtEnabled.value && loadingChains.value.has(chainId.value))
  const badDebtError = computed(() => isBadDebtEnabled.value ? errorByChain.value.get(chainId.value) : undefined)
  const isBadDebtLoaded = computed(() =>
    isBadDebtEnabled.value && badDebtByChain.value.has(chainId.value) && !errorByChain.value.has(chainId.value),
  )

  return {
    badDebtByChain,
    badDebtError,
    getVaultBadDebt,
    isBadDebtEnabled,
    isBadDebtLoaded,
    isBadDebtLoading,
    loadBadDebtForChain,
  }
}
