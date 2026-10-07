import { DEFAULT_V3_IMAGES_URL } from '~/utils/api-url-env'
import { v3OracleProviderLogoUrl } from '~/utils/v3-images'

const ORACLE_PROVIDER_IMAGE_KEYS: Record<string, string> = {
  // API provider names
  'API3': 'api3',
  'Chainlink': 'chainlink',
  'Chronicle': 'chronicle',
  'eOracle': 'eoracle',
  'ERC4626Vault': 'erc4626',
  'Idle': 'idle',
  'Lido': 'lido',
  'Mev': 'mev',
  'Midas': 'midas',
  'Pendle': 'pendle',
  'Poppie': 'poppie',
  'Pyth': 'pyth',
  'Redstone': 'redstone',
  'RedStone': 'redstone',
  'Resolv': 'resolv',
  'FixedRate': 'fixed-rate',
  'Fixed Rate': 'fixed-rate',
  'RateProvider': 'rate-provider',
  'Rate Provider': 'rate-provider',
  'Uniswap V3': 'uniswap-v3',
  // Oracle tree adapter names (fallback when no API provider metadata)
  'ChainlinkOracle': 'chainlink',
  'ChainlinkInfrequentOracle': 'chainlink',
  'PythOracle': 'pyth',
  'ChronicleOracle': 'chronicle',
  'RedstoneClassicOracle': 'redstone',
  'RedstoneCoreOracle': 'redstone',
  'RedStonePull': 'redstone',
  'RedStone Pull': 'redstone',
  'MEV Capital': 'mev',
  'PendleOracle': 'pendle',
  'PendleUniversalOracle': 'pendle',
  'LidoFundamental': 'lido',
  'Lido Fundamental': 'lido',
  'MEVCapital': 'mev',
  'MEVLinearDiscount': 'mev',
  'FixedRateOracle': 'fixed-rate',
  'RateProviderOracle': 'rate-provider',
  'UniswapV3Oracle': 'uniswap-v3',
}

// Providers V3 reports today with no managed image yet (Stork, Curve, Swaap,
// Cross, DIA, Re Protocol, InfiniFi Custom Oracle) are intentionally unmapped:
// a missing image degrades to the question-mark icon, whereas a mapped 404
// would fall back to an initials avatar. Add them here once the image exists
// under `/v3/images/oracle-providers/`.
const resolveOracleProviderImage = (identifier: string | undefined, imagesBaseUrl: string): string | undefined => {
  if (!identifier || !Object.hasOwn(ORACLE_PROVIDER_IMAGE_KEYS, identifier)) return undefined
  return v3OracleProviderLogoUrl(ORACLE_PROVIDER_IMAGE_KEYS[identifier], imagesBaseUrl)
}

export const getOracleProviderLogo = (
  provider?: string,
  adapterName?: string,
  imagesBaseUrl: string = DEFAULT_V3_IMAGES_URL,
): string | undefined => {
  // When provider is known, only use its logo — never fall through to adapter name
  // This prevents e.g. Midas (using ChainlinkOracle) from showing Chainlink's logo
  if (provider) {
    return resolveOracleProviderImage(provider, imagesBaseUrl)
  }
  return resolveOracleProviderImage(adapterName, imagesBaseUrl)
}
