import { V3_API_PROXY_URL } from '~/utils/api-url-env'
import { logWarn } from '~/utils/errorHandling'
import { isV3AggregateRereadDue, readV3RefreshedAt, type V3AggregateCopy } from '~/utils/v3-aggregate-freshness'
import {
  findOpenInterestMapForVault,
  type OpenInterestCollateralMapResponse,
} from '~/utils/vault/open-interest'

let pendingLoad: Promise<void> | null = null
let pendingRefresh: Promise<void> | null = null
let pendingChainId: string | null = null
let activeRequestId = 0

const fetchOpenInterest = (chainId: string) => $fetch<OpenInterestCollateralMapResponse>(
  `${V3_API_PROXY_URL}/evk/vaults/open-interest/by-collateral?chainId=${encodeURIComponent(chainId)}`,
)

export const useCollateralOpenInterest = () => {
  const { chainId } = useEulerAddresses()
  const { isV3EnabledForChain } = useV3ChainGate()
  const data = useState<Record<string, Record<string, number>>>('collateral-open-interest:data', () => ({}))
  const loadedChainId = useState<string | null>('collateral-open-interest:chain-id', () => null)
  const isLoading = useState('collateral-open-interest:is-loading', () => false)
  const hasError = useState('collateral-open-interest:has-error', () => false)
  const copy = useState<V3AggregateCopy | null>('collateral-open-interest:copy', () => null)
  const currentChainId = computed(() => chainId.value ? String(chainId.value) : '')
  const isOpenInterestEnabled = computed(() => isV3EnabledForChain(chainId.value))
  const isLoaded = computed(() =>
    isOpenInterestEnabled.value
    && !!currentChainId.value
    && loadedChainId.value === currentChainId.value
    && !hasError.value,
  )

  const load = async () => {
    if (!isOpenInterestEnabled.value) {
      isLoading.value = false
      hasError.value = false
      return
    }
    const chainIdToLoad = currentChainId.value
    if (!chainIdToLoad) return
    if (loadedChainId.value === chainIdToLoad) return
    if (pendingLoad && pendingChainId === chainIdToLoad) return pendingLoad

    const requestId = ++activeRequestId
    const readAt = Date.now()
    isLoading.value = true
    hasError.value = false
    pendingChainId = chainIdToLoad
    const loadPromise = fetchOpenInterest(chainIdToLoad)
      .then((response) => {
        if (requestId !== activeRequestId || currentChainId.value !== chainIdToLoad) return

        data.value = response.data ?? {}
        copy.value = { refreshedAt: readV3RefreshedAt(response), readAt }
        loadedChainId.value = chainIdToLoad
      })
      .catch(() => {
        if (requestId !== activeRequestId || currentChainId.value !== chainIdToLoad) return

        hasError.value = true
        data.value = {}
        loadedChainId.value = null
      })
      .finally(() => {
        if (pendingLoad !== loadPromise) return

        isLoading.value = false
        pendingLoad = null
        pendingChainId = null
      })

    pendingLoad = loadPromise
    return pendingLoad
  }

  /** Shows no loading or error state, and keeps the loaded values when the read fails. */
  const refreshIfStale = async () => {
    if (!isLoaded.value || pendingLoad || pendingRefresh) return
    if (!copy.value || !isV3AggregateRereadDue(copy.value)) return

    const requestId = ++activeRequestId
    const readAt = Date.now()
    const chainIdToLoad = currentChainId.value
    const refreshPromise = fetchOpenInterest(chainIdToLoad)
      .then((response) => {
        if (requestId !== activeRequestId || currentChainId.value !== chainIdToLoad) return

        data.value = response.data ?? {}
        copy.value = { refreshedAt: readV3RefreshedAt(response), readAt }
      })
      .catch(error => logWarn('useCollateralOpenInterest/refresh', error))
      .finally(() => {
        if (pendingRefresh === refreshPromise) pendingRefresh = null
      })

    pendingRefresh = refreshPromise
    return refreshPromise
  }

  const getOpenInterestForVault = (vaultAddress: string): Record<string, number> =>
    findOpenInterestMapForVault(data.value, vaultAddress)

  return {
    data,
    hasError,
    isLoaded,
    isLoading,
    isOpenInterestEnabled,
    load,
    refreshIfStale,
    getOpenInterestForVault,
  }
}
