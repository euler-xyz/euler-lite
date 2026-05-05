import { describe, expect, it } from 'vitest'
import { isShowAllLabelEntriesQuery } from '~/composables/useShowAllLabelEntries'

describe('isShowAllLabelEntriesQuery', () => {
  it('enables showAll for true-like URL values and presence-only query params', () => {
    expect(isShowAllLabelEntriesQuery('true')).toBe(true)
    expect(isShowAllLabelEntriesQuery('TRUE')).toBe(true)
    expect(isShowAllLabelEntriesQuery('1')).toBe(true)
    expect(isShowAllLabelEntriesQuery('')).toBe(true)
    expect(isShowAllLabelEntriesQuery(null)).toBe(true)
    expect(isShowAllLabelEntriesQuery(['0', 'true'])).toBe(true)
  })

  it('keeps default behavior for missing or false-like values', () => {
    expect(isShowAllLabelEntriesQuery(undefined)).toBe(false)
    expect(isShowAllLabelEntriesQuery('false')).toBe(false)
    expect(isShowAllLabelEntriesQuery('0')).toBe(false)
    expect(isShowAllLabelEntriesQuery(['0', 'false'])).toBe(false)
  })
})
