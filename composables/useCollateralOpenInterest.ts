import {
  findOpenInterestMapForVault,
  type OpenInterestCollateralMapResponse,
} from '~/utils/vault/open-interest'

let pendingLoad: Promise<void> | null = null
let pendingChainId: string | null = null
let activeRequestId = 0

export const useCollateralOpenInterest = () => {
  const { chainId } = useEulerAddresses()
  const { enableV3Backend } = useEnvConfig()
  const data = useState<Record<string, Record<string, number>>>('collateral-open-interest:data', () => ({}))
  const loadedChainId = useState<string | null>('collateral-open-interest:chain-id', () => null)
  const isLoading = useState('collateral-open-interest:is-loading', () => false)
  const hasError = useState('collateral-open-interest:has-error', () => false)
  const currentChainId = computed(() => chainId.value ? String(chainId.value) : '')
  const isOpenInterestEnabled = computed(() => enableV3Backend)
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
    isLoading.value = true
    hasError.value = false
    pendingChainId = chainIdToLoad
    const loadPromise = $fetch<OpenInterestCollateralMapResponse>(
      `/api/v3/evk/vaults/open-interest/by-collateral?chainId=${encodeURIComponent(chainIdToLoad)}`,
    )
      .then((response) => {
        if (requestId !== activeRequestId || currentChainId.value !== chainIdToLoad) return

        data.value = response.data ?? {}
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

  const getOpenInterestForVault = (vaultAddress: string): Record<string, number> =>
    findOpenInterestMapForVault(data.value, vaultAddress)

  return {
    data,
    hasError,
    isLoaded,
    isLoading,
    isOpenInterestEnabled,
    load,
    getOpenInterestForVault,
  }
}
