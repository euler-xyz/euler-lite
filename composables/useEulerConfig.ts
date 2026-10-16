import {
  DEFILLAMA_YIELDS_URL,
  MERKL_API_BASE_URL,
} from '~/entities/constants'

export const useEulerConfig = () => {
  const envConfig = useEnvConfig()

  return {
    // APIs (from constants)
    DEFILLAMA_YIELDS_URL,
    MERKL_API_BASE_URL,

    // Runtime app config APIs
    SWAP_API_URL: envConfig.swapApiUrl,
    PYTH_HERMES_URL: envConfig.pythHermesUrl,
  }
}
