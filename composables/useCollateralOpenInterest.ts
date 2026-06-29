import {
  findOpenInterestMapForVault,
  type OpenInterestCollateralMapResponse,
} from '~/utils/vault/open-interest'

let pendingLoad: Promise<void> | null = null
let pendingChainId: string | null = null

export const useCollateralOpenInterest = () => {
  const { chainId } = useEulerAddresses()
  const data = useState<Record<string, Record<string, number>>>('collateral-open-interest:data', () => ({}))
  const loadedChainId = useState<string | null>('collateral-open-interest:chain-id', () => null)
  const isLoading = useState('collateral-open-interest:is-loading', () => false)
  const hasError = useState('collateral-open-interest:has-error', () => false)
  const currentChainId = computed(() => chainId.value ? String(chainId.value) : '')
  const isLoaded = computed(() => !!currentChainId.value && loadedChainId.value === currentChainId.value && !hasError.value)

  const load = async () => {
    const chainIdToLoad = currentChainId.value
    if (!chainIdToLoad) return
    if (loadedChainId.value === chainIdToLoad) return
    if (pendingLoad && pendingChainId === chainIdToLoad) return pendingLoad

    isLoading.value = true
    hasError.value = false
    pendingChainId = chainIdToLoad
    pendingLoad = $fetch<OpenInterestCollateralMapResponse>(
      `/api/v3/evk/vaults/open-interest/by-collateral?chainId=${encodeURIComponent(chainIdToLoad)}`,
    )
      .then((response) => {
        data.value = response.data ?? {}
        loadedChainId.value = chainIdToLoad
      })
      .catch(() => {
        hasError.value = true
        data.value = {}
        loadedChainId.value = null
      })
      .finally(() => {
        isLoading.value = false
        pendingLoad = null
        pendingChainId = null
      })

    return pendingLoad
  }

  const getOpenInterestForVault = (vaultAddress: string): Record<string, number> =>
    findOpenInterestMapForVault(data.value, vaultAddress)

  return {
    data,
    hasError,
    isLoaded,
    isLoading,
    load,
    getOpenInterestForVault,
  }
}
