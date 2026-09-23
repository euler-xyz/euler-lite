import { describe, expect, it } from 'vitest'
import { resolveUrlQueryValue } from '~/utils/url-query-alias'

// The curator filter's link parameter was renamed from riskManager (Lend,
// Borrow, Explore) and allocator (Earn) to curator; saved links keep working.
describe('resolveUrlQueryValue', () => {
  it('reads the current parameter name first', () => {
    expect(resolveUrlQueryValue({ curator: 'Acme', riskManager: 'Old' }, 'curator', ['riskManager']))
      .toEqual({ fromLegacy: false, legacyPresent: true, value: 'Acme' })
    expect(resolveUrlQueryValue({ curator: 'Acme' }, 'curator', ['riskManager']))
      .toEqual({ fromLegacy: false, legacyPresent: false, value: 'Acme' })
  })

  it('falls back to a former name and says so', () => {
    expect(resolveUrlQueryValue({ riskManager: ['Acme', 'Beta'] }, 'curator', ['riskManager']))
      .toEqual({ fromLegacy: true, legacyPresent: true, value: ['Acme', 'Beta'] })
    expect(resolveUrlQueryValue({ allocator: 'Acme' }, 'curator', ['allocator']))
      .toEqual({ fromLegacy: true, legacyPresent: true, value: 'Acme' })
  })

  it('is undefined when neither name is present, and ignores former names it was not given', () => {
    expect(resolveUrlQueryValue({}, 'curator', ['riskManager'])).toEqual({ fromLegacy: false, legacyPresent: false, value: undefined })
    expect(resolveUrlQueryValue({ allocator: 'Acme' }, 'curator', ['riskManager'])).toEqual({ fromLegacy: false, legacyPresent: false, value: undefined })
    expect(resolveUrlQueryValue({ riskManager: 'Acme' }, 'curator')).toEqual({ fromLegacy: false, legacyPresent: false, value: undefined })
  })
})
