import { describe, expect, it } from 'vitest'
import { getOracleProviderLogo } from '~/entities/oracle-providers'

const BASE = 'https://v3.example/v3/images'
const imageUrl = (key: string) => `${BASE}/oracle-providers/${key}`

describe('getOracleProviderLogo', () => {
  it('resolves API provider names through the V3 managed-image namespace', () => {
    expect(getOracleProviderLogo('Chainlink', undefined, BASE)).toBe(imageUrl('chainlink'))
    expect(getOracleProviderLogo('Uniswap V3', undefined, BASE)).toBe(imageUrl('uniswap-v3'))
  })

  it('resolves adapter names only when provider metadata is absent', () => {
    expect(getOracleProviderLogo(undefined, 'UniswapV3Oracle', BASE)).toBe(imageUrl('uniswap-v3'))
    expect(getOracleProviderLogo('Midas', 'ChainlinkOracle', BASE)).toBe(imageUrl('midas'))
  })

  it('maps the provider strings V3 reports with spaces', () => {
    expect(getOracleProviderLogo('RedStone Pull', undefined, BASE)).toBe(imageUrl('redstone'))
    expect(getOracleProviderLogo('MEV Capital', undefined, BASE)).toBe(imageUrl('mev'))
    expect(getOracleProviderLogo('Lido Fundamental', undefined, BASE)).toBe(imageUrl('lido'))
  })

  it('shows no logo when the images base is unknown', () => {
    expect(getOracleProviderLogo('Chainlink', undefined, '')).toBeUndefined()
    expect(getOracleProviderLogo('Chainlink')).toBeUndefined()
  })

  it('does not infer a logo for an unknown provider', () => {
    expect(getOracleProviderLogo('Unknown provider', 'ChainlinkOracle', BASE)).toBeUndefined()
  })
})
