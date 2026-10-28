import { describe, it, expect } from 'vitest'
import { createRaceGuard, runGuarded } from '~/utils/race-guard'

describe('createRaceGuard', () => {
  it('starts at generation 0', () => {
    const guard = createRaceGuard()
    expect(guard.current()).toBe(0)
  })

  it('increments on next()', () => {
    const guard = createRaceGuard()
    expect(guard.next()).toBe(1)
    expect(guard.next()).toBe(2)
    expect(guard.current()).toBe(2)
  })

  it('detects stale generation', () => {
    const guard = createRaceGuard()
    const gen = guard.current()
    expect(guard.isStale(gen)).toBe(false)
    guard.next()
    expect(guard.isStale(gen)).toBe(true)
  })

  it('current generation is never stale', () => {
    const guard = createRaceGuard()
    guard.next()
    guard.next()
    const gen = guard.current()
    expect(guard.isStale(gen)).toBe(false)
  })
})

describe('runGuarded', () => {
  const settleAfter = <T>(value: T, ms: number) =>
    new Promise<T>(resolve => setTimeout(() => resolve(value), ms))

  it('commits the result when no newer run started', async () => {
    const guard = createRaceGuard()
    let committed = '-'

    await runGuarded(guard, () => settleAfter('fresh', 1), (value) => {
      committed = value
    })

    expect(committed).toBe('fresh')
  })

  // Regression: a slow early run must not overwrite a fresher result that
  // already landed — the failure mode when a second read retriggers formatting.
  it('drops an out-of-order result from a superseded run', async () => {
    const guard = createRaceGuard()
    let committed = '-'
    const commit = (value: string) => {
      committed = value
    }

    const slowFirst = runGuarded(guard, () => settleAfter('stale', 30), commit)
    const fastSecond = runGuarded(guard, () => settleAfter('fresh', 5), commit)

    await Promise.all([slowFirst, fastSecond])

    expect(committed).toBe('fresh')
  })

  it('does not commit when the task rejects', async () => {
    const guard = createRaceGuard()
    let committed = '-'

    await expect(
      runGuarded(guard, () => Promise.reject(new Error('boom')), (value: string) => { committed = value }),
    ).rejects.toThrow('boom')

    expect(committed).toBe('-')
  })
})
