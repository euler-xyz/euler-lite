import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  ACTIVITY_CLOCK_INTERVAL_MS,
  useActivityNowMs,
} from '~/composables/useActivityNowMs'

const NOW = Date.parse('2026-07-21T10:00:00.000Z')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useActivityNowMs', () => {
  it('advances the shared Activity clock without another feed update', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubGlobal('window', {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    })

    const scope = effectScope()
    const nowMs = scope.run(useActivityNowMs)
    if (!nowMs) throw new Error('Activity clock failed to mount')

    expect(nowMs.value).toBe(NOW)

    await vi.advanceTimersByTimeAsync(ACTIVITY_CLOCK_INTERVAL_MS)

    expect(nowMs.value).toBe(NOW + ACTIVITY_CLOCK_INTERVAL_MS)

    scope.stop()
    await vi.advanceTimersByTimeAsync(ACTIVITY_CLOCK_INTERVAL_MS)
    expect(nowMs.value).toBe(NOW + ACTIVITY_CLOCK_INTERVAL_MS)
  })
})
