import { describe, expect, it } from 'vitest'
import { getOracleProviderLogo } from '~/entities/oracle-providers'

const imageUrl = (key: string) => `https://v3.euler.finance/v3/images/oracle-providers/${key}`

describe('getOracleProviderLogo', () => {
  it('resolves API provider names through the V3 managed-image namespace', () => {
    expect(getOracleProviderLogo('Chainlink')).toBe(imageUrl('chainlink'))
    expect(getOracleProviderLogo('Uniswap V3')).toBe(imageUrl('uniswap-v3'))
  })

  it('resolves adapter names only when provider metadata is absent', () => {
    expect(getOracleProviderLogo(undefined, 'UniswapV3Oracle')).toBe(imageUrl('uniswap-v3'))
    expect(getOracleProviderLogo('Midas', 'ChainlinkOracle')).toBe(imageUrl('midas'))
  })

  it('maps the provider strings V3 reports with spaces', () => {
    expect(getOracleProviderLogo('RedStone Pull')).toBe(imageUrl('redstone'))
    expect(getOracleProviderLogo('MEV Capital')).toBe(imageUrl('mev'))
    expect(getOracleProviderLogo('Lido Fundamental')).toBe(imageUrl('lido'))
  })

  it('does not infer a logo for an unknown provider', () => {
    expect(getOracleProviderLogo('Unknown provider', 'ChainlinkOracle')).toBeUndefined()
  })
})
