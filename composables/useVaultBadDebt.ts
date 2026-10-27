import { V3_API_PROXY_URL } from '~/utils/api-url-env'
import { logWarn } from '~/utils/errorHandling'
import { isV3AggregateRereadDue, readV3RefreshedAt, type V3AggregateCopy } from '~/utils/v3-aggregate-freshness'
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
const copyByChain = new Map<number, V3AggregateCopy>()

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
): Promise<{ rows: V3VaultBadDebtRow[], refreshedAt: string | null }> => {
  const limit = 100
  let offset = 0
  let refreshedAt: string | null = null
  const rows: V3VaultBadDebtRow[] = []

  while (true) {
    const response = await fetch(buildBadDebtUrl(baseUrl, chainId, offset, limit), {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`Bad debt fetch failed with ${response.status}`)
    }

    const body = await response.json()
    const page = parseBadDebtResponse(body)
    refreshedAt ??= readV3RefreshedAt(body)
    rows.push(...page)
    if (page.length < limit) return { rows, refreshedAt }
    offset += limit
  }
}

export const useVaultBadDebt = () => {
  const { chainId } = useEulerAddresses()
  const envConfig = useEnvConfig()
  const { isV3EnabledForChain } = useV3ChainGate()
  const isBadDebtEnabled = computed(() => isV3EnabledForChain(chainId.value))

  /** A silent load keeps the loaded values and shows no loading or error state. */
  const loadBadDebtForChain = async (
    targetChainId = chainId.value,
    { force = false, silent = false }: { force?: boolean, silent?: boolean } = {},
  ) => {
    if (!isV3EnabledForChain(targetChainId)) {
      setChainLoading(targetChainId, false)
      setChainError(targetChainId, null)
      return
    }
    if (!force && badDebtByChain.value.has(targetChainId) && !errorByChain.value.has(targetChainId)) return
    const existing = inFlight.get(targetChainId)
    if (existing) return existing

    const promise = (async () => {
      if (!silent) {
        setChainLoading(targetChainId, true)
        setChainError(targetChainId, null)
      }
      try {
        const readAt = Date.now()
        const { rows, refreshedAt } = await fetchBadDebtRows(envConfig.v3ApiUrl, targetChainId)
        setChainCache(targetChainId, buildBadDebtCache(rows))
        copyByChain.set(targetChainId, { refreshedAt, readAt })
      }
      catch (err) {
        if (silent) logWarn('useVaultBadDebt/refresh', err)
        else setChainError(targetChainId, err instanceof Error ? err : new Error(String(err)))
      }
      finally {
        if (!silent) setChainLoading(targetChainId, false)
        inFlight.delete(targetChainId)
      }
    })()

    inFlight.set(targetChainId, promise)
    return promise
  }

  const refreshBadDebtIfStale = async (targetChainId = chainId.value) => {
    const copy = copyByChain.get(targetChainId)
    if (!copy || !badDebtByChain.value.has(targetChainId) || errorByChain.value.has(targetChainId)) return
    if (!isV3AggregateRereadDue(copy)) return
    return loadBadDebtForChain(targetChainId, { force: true, silent: true })
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
    refreshBadDebtIfStale,
  }
}
