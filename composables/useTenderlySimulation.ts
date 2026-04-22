import type { Address, Hex } from 'viem'

interface TenderlySimulateParams {
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: string
  stateOverrides: { address: Address, stateDiff?: { slot: Hex, value: Hex }[] }[]
}

interface TenderlySimulateResponse {
  url: string
  errorMessage?: string
}

interface TenderlyFetchError {
  message?: string
  statusMessage?: string
  data?: {
    statusMessage?: string
    message?: string
  }
}

function getTenderlyErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const fetchError = error as TenderlyFetchError
    const candidates = [
      fetchError.data?.statusMessage,
      fetchError.statusMessage,
      fetchError.data?.message,
      fetchError.message,
    ]

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  }

  return 'Tenderly simulation failed'
}

export const useTenderlySimulation = () => {
  const isSimulating = ref(false)
  const simulationError = ref('')
  const simulationUrl = ref('')

  const clearSimulation = () => {
    simulationError.value = ''
    simulationUrl.value = ''
  }

  const simulate = async (params: TenderlySimulateParams): Promise<string | null> => {
    clearSimulation()
    isSimulating.value = true

    try {
      const response = await $fetch<TenderlySimulateResponse>('/api/tenderly/simulate', {
        method: 'POST',
        body: params,
      })

      simulationUrl.value = response.url
      simulationError.value = response.errorMessage?.trim() || ''
      return response.url
    }
    catch (error: unknown) {
      simulationError.value = getTenderlyErrorMessage(error)
      return null
    }
    finally {
      isSimulating.value = false
    }
  }

  const fetchEnabled = async (): Promise<boolean> => {
    try {
      const { enabled } = await $fetch<{ enabled: boolean }>('/api/tenderly/status')
      return enabled
    }
    catch {
      return false
    }
  }

  return {
    isSimulating,
    simulationError,
    simulationUrl,
    simulate,
    clearSimulation,
    fetchEnabled,
  }
}
