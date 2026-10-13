import { v3OracleProviderLogoUrl } from '~/utils/v3-images'
import { getBundledOracleProviderLogo } from '~/utils/oracle-provider-logo'

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

// Remote and bundled artwork share the same provider-first identity mapping.
// Unknown providers keep the question-mark icon, even if the adapter name maps.
const resolveOracleProviderImageKey = (provider?: string, adapterName?: string): string | undefined => {
  const identifier = provider || adapterName
  if (!identifier || !Object.hasOwn(ORACLE_PROVIDER_IMAGE_KEYS, identifier)) return undefined
  return ORACLE_PROVIDER_IMAGE_KEYS[identifier]
}

export const getOracleProviderLogo = (
  provider?: string,
  adapterName?: string,
  imagesBaseUrl?: string,
): string | undefined => {
  const key = resolveOracleProviderImageKey(provider, adapterName)
  return key ? v3OracleProviderLogoUrl(key, imagesBaseUrl) : undefined
}

export const getOracleProviderFallbackLogo = (provider?: string, adapterName?: string): string | undefined => {
  const key = resolveOracleProviderImageKey(provider, adapterName)
  return key ? getBundledOracleProviderLogo(key) : undefined
}
