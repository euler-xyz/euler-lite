import { describe, expect, it } from 'vitest'
import { getREULLockClosedAt, isREULLockOpen } from '~/entities/reul'

const day = 1_791_331_200n

describe('isREULLockOpen', () => {
  it('keeps the lock open through its UTC day and the margin', () => {
    const closedAt = getREULLockClosedAt(day)

    expect(closedAt).toBe(day + 86_400n + 3_600n)
    expect(isREULLockOpen(day, day)).toBe(true)
    expect(isREULLockOpen(day, day + 86_400n)).toBe(true)
    expect(isREULLockOpen(day, closedAt - 1n)).toBe(true)
  })

  it('closes the lock once the margin after its UTC day has passed', () => {
    const closedAt = getREULLockClosedAt(day)

    expect(isREULLockOpen(day, closedAt)).toBe(false)
    expect(isREULLockOpen(day, closedAt + 86_400n)).toBe(false)
  })
})
