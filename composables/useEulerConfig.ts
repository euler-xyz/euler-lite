import {
  DEFILLAMA_YIELDS_URL,
  MERKL_API_BASE_URL,
} from '~/entities/constants'

export const useEulerConfig = () => {
  const envConfig = useEnvConfig()
  const { labelsRepo, labelsRepoBranch, labelsBaseUrl: configLabelsBaseUrl } = useDeployConfig()
  const { subgraphUris } = useChainConfig()
  const { chainId } = useEulerAddresses()

  const resolvedLabelsBaseUrl = (
    configLabelsBaseUrl
    || `https://raw.githubusercontent.com/${labelsRepo}/refs/heads/${labelsRepoBranch}`
  ).replace(/\/+$/, '')

  return {
    // APIs (from constants)
    DEFILLAMA_YIELDS_URL,
    MERKL_API_BASE_URL,

    // Labels
    EULER_LABELS_ENTITY_LOGO_URL: `${resolvedLabelsBaseUrl}/logo`,

    // Runtime app config APIs
    SWAP_API_URL: envConfig.swapApiUrl,
    PYTH_HERMES_URL: envConfig.pythHermesUrl,

    // Chain-specific (computed)
    SUBGRAPH_URL: computed(() => subgraphUris[String(chainId.value)] || '').value,
  }
}
