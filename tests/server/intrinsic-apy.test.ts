import { describe, expect, it } from 'vitest'
import { extractLatestYuzuApy } from '~/server/utils/intrinsic-apy'

describe('extractLatestYuzuApy', () => {
  it('uses the configured APY field from the latest date', () => {
    const rows = [
      { date: '2026-05-18', ts: '1779065174400', yzprime_apy_7d: 5.9, yzprime_apy_30d: 5.8 },
      { date: '2026-05-19', ts: '1779151572900', yzprime_apy_7d: 6.0, yzprime_apy_30d: 6.0 },
      { date: '2026-05-20', ts: '1779241574271', yzprime_apy_7d: 6.1, yzprime_apy_30d: 6.0 },
    ]

    expect(extractLatestYuzuApy(rows, 'yzprime_apy_7d')).toBe(6.1)
  })

  it('uses the highest timestamp when multiple rows share the latest date', () => {
    const rows = [
      { date: '2026-05-20', ts: '1779241574271', yzprime_apy_7d: 6.1 },
      { date: '2026-05-20', ts: '1779287476493', yzprime_apy_7d: 6.2 },
      { date: '2026-05-19', ts: '1779151572900', yzprime_apy_7d: 7.0 },
    ]

    expect(extractLatestYuzuApy(rows, 'yzprime_apy_7d')).toBe(6.2)
  })

  it('returns null when the latest row lacks the configured APY field', () => {
    const rows = [
      { date: '2026-05-19', ts: '1779151572900', yzprime_apy_7d: 6.0 },
      { date: '2026-05-20', ts: '1779287476493', yzprime_apy_30d: 6.1 },
    ]

    expect(extractLatestYuzuApy(rows, 'yzprime_apy_7d')).toBeNull()
  })
})
