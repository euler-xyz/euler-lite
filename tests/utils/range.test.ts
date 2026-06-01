import { describe, expect, it } from 'vitest'
import { snapRangeValue } from '~/utils/range'

describe('snapRangeValue', () => {
  it('clamps rounded values to max', () => {
    expect(snapRangeValue(5.88, 1, 5.87, 0.1)).toBe(5.87)
  })

  it('snaps in-range values to the nearest step', () => {
    expect(snapRangeValue(2.24, 1, 5.87, 0.1)).toBe(2.2)
    expect(snapRangeValue(2.25, 1, 5.87, 0.1)).toBe(2.3)
  })
})
