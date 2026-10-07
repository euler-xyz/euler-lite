import { DEFAULT_V3_IMAGES_URL } from '~/utils/api-url-env'

export const v3ChainLogoUrl = (chainId: number, imagesBaseUrl: string = DEFAULT_V3_IMAGES_URL): string =>
  `${imagesBaseUrl}/v3/images/chains/${chainId}`

export const v3OracleProviderLogoUrl = (key: string, imagesBaseUrl: string = DEFAULT_V3_IMAGES_URL): string =>
  `${imagesBaseUrl}/v3/images/oracle-providers/${encodeURIComponent(key)}`
