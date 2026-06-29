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

  const load = async () => {
    const currentChainId = chainId.value ? String(chainId.value) : ''
    if (!currentChainId) return
    if (loadedChainId.value === currentChainId) return
    if (pendingLoad && pendingChainId === currentChainId) return pendingLoad

    isLoading.value = true
    hasError.value = false
    pendingChainId = currentChainId
    pendingLoad = $fetch<OpenInterestCollateralMapResponse>(
      `/api/v3/evk/vaults/open-interest/by-collateral?chainId=${encodeURIComponent(currentChainId)}`,
    )
      .then((response) => {
        data.value = response.data ?? {}
        loadedChainId.value = currentChainId
      })
      .catch(() => {
        hasError.value = true
        data.value = {}
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
    isLoading,
    load,
    getOpenInterestForVault,
  }
}
