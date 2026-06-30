import { describe, expect, it } from 'vitest'

import { formatMarketAvailability } from '~/utils/vault-display'

describe('formatMarketAvailability', () => {
  it('formats unavailable, singular, and plural market counts', () => {
    expect(formatMarketAvailability(0)).toBe('No')
    expect(formatMarketAvailability(1)).toBe('Yes in 1 market')
    expect(formatMarketAvailability(2)).toBe('Yes in 2 markets')
  })
})
