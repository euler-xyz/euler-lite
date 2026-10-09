import { describe, expect, it } from 'vitest'
import { getREULLockClosedAt, isREULLockOpen } from '~/entities/reul'

const day = 1_791_331_200n
const toMs = (seconds: bigint) => Number(seconds) * 1000

describe('isREULLockOpen', () => {
  it('keeps the lock open through its UTC day and the clock margin', () => {
    const closedAt = getREULLockClosedAt(day)

    expect(closedAt).toBe(day + 86_400n + 3_600n)
    expect(isREULLockOpen(day, toMs(day))).toBe(true)
    expect(isREULLockOpen(day, toMs(day + 86_400n))).toBe(true)
    expect(isREULLockOpen(day, toMs(closedAt) - 1)).toBe(true)
  })

  it('closes the lock once the margin after its UTC day has passed', () => {
    const closedAt = getREULLockClosedAt(day)

    expect(isREULLockOpen(day, toMs(closedAt))).toBe(false)
    expect(isREULLockOpen(day, toMs(closedAt + 86_400n))).toBe(false)
  })
})
