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
  const base = baseUrl.replace(/\/+$/, '') || '/api/v3'
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
    const response = await fetch(buildBadDebtUrl(baseUrl, chainId, offset, limit), {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`Bad debt fetch failed with ${response.status}`)
    }

    const body = await response.json()
    const page = parseBadDebtResponse(body)
    rows.push(...page)
    if (page.length < limit) return rows
    offset += limit
  }
}

export const useVaultBadDebt = () => {
  const { chainId } = useEulerAddresses()
  const envConfig = useEnvConfig()

  const loadBadDebtForChain = async (
    targetChainId = chainId.value,
    { force = false }: { force?: boolean } = {},
  ) => {
    if (!force && badDebtByChain.value.has(targetChainId) && !errorByChain.value.has(targetChainId)) return
    const existing = inFlight.get(targetChainId)
    if (existing) return existing

    const promise = (async () => {
      setChainLoading(targetChainId, true)
      setChainError(targetChainId, null)
      try {
        const rows = await fetchBadDebtRows(envConfig.v3ApiUrl, targetChainId)
        setChainCache(targetChainId, buildBadDebtCache(rows))
      }
      catch (err) {
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

  const isBadDebtLoading = computed(() => loadingChains.value.has(chainId.value))
  const badDebtError = computed(() => errorByChain.value.get(chainId.value))
  const isBadDebtLoaded = computed(() =>
    badDebtByChain.value.has(chainId.value) && !errorByChain.value.has(chainId.value),
  )

  return {
    badDebtByChain,
    badDebtError,
    getVaultBadDebt,
    isBadDebtLoaded,
    isBadDebtLoading,
    loadBadDebtForChain,
  }
}
