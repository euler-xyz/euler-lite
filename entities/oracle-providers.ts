const ORACLE_PROVIDER_LOGOS: Record<string, string> = {
  // API provider names
  'API3': '/oracles/api3.svg',
  'Chainlink': '/oracles/chainlink.svg',
  'Chronicle': '/oracles/chronicle.svg',
  'eOracle': '/oracles/eoracle.svg',
  'ERC4626Vault': '/oracles/erc4626.svg',
  'Idle': '/oracles/idle.svg',
  'Lido': '/oracles/lido.svg',
  'Mev': '/oracles/mev.svg',
  'Midas': '/oracles/midas.svg',
  'Pendle': '/oracles/pendle.svg',
  'Poppie': '/oracles/poppie.svg',
  'Pyth': '/oracles/pyth.svg',
  'Redstone': '/oracles/redstone.svg',
  'RedStone': '/oracles/redstone.svg',
  'Resolv': '/oracles/resolv.svg',
  'FixedRate': '/oracles/fixed-rate.svg',
  'Fixed Rate': '/oracles/fixed-rate.svg',
  'RateProvider': '/oracles/rate-provider.svg',
  'Rate Provider': '/oracles/rate-provider.svg',
  // Oracle tree adapter names (fallback when no API provider metadata)
  'ChainlinkOracle': '/oracles/chainlink.svg',
  'ChainlinkInfrequentOracle': '/oracles/chainlink.svg',
  'PythOracle': '/oracles/pyth.svg',
  'ChronicleOracle': '/oracles/chronicle.svg',
  'RedstoneClassicOracle': '/oracles/redstone.svg',
  'RedstoneCoreOracle': '/oracles/redstone.svg',
  'RedStonePull': '/oracles/redstone.svg',
  'PendleOracle': '/oracles/pendle.svg',
  'PendleUniversalOracle': '/oracles/pendle.svg',
  'LidoFundamental': '/oracles/lido.svg',
  'Lido Fundamental': '/oracles/lido.svg',
  'MEVCapital': '/oracles/mev.svg',
  'MEVLinearDiscount': '/oracles/mev.svg',
  'FixedRateOracle': '/oracles/fixed-rate.svg',
  'RateProviderOracle': '/oracles/rate-provider.svg',
}

export const getOracleProviderLogo = (provider?: string, adapterName?: string): string | undefined => {
  // When provider is known, only use its logo — never fall through to adapter name
  // This prevents e.g. Midas (using ChainlinkOracle) from showing Chainlink's logo
  if (provider) {
    if (Object.hasOwn(ORACLE_PROVIDER_LOGOS, provider)) {
      return ORACLE_PROVIDER_LOGOS[provider]
    }
    return undefined
  }
  if (adapterName && Object.hasOwn(ORACLE_PROVIDER_LOGOS, adapterName)) {
    return ORACLE_PROVIDER_LOGOS[adapterName]
  }
  return undefined
}
