import { describe, expect, it } from 'vitest'
import { v3ChainLogoUrl, v3OracleProviderLogoUrl } from '~/utils/v3-images'

describe('V3 image URLs', () => {
  it('builds the chain logo URL on the default host', () => {
    expect(v3ChainLogoUrl(8453)).toBe('https://v3.euler.finance/v3/images/chains/8453')
  })

  it('builds image URLs on a configured host', () => {
    expect(v3ChainLogoUrl(1, 'https://images.example')).toBe('https://images.example/v3/images/chains/1')
    expect(v3OracleProviderLogoUrl('pyth', 'https://images.example')).toBe('https://images.example/v3/images/oracle-providers/pyth')
  })

  it('encodes the oracle provider key as one path segment', () => {
    expect(v3OracleProviderLogoUrl('a/b')).toBe('https://v3.euler.finance/v3/images/oracle-providers/a%2Fb')
  })
})
