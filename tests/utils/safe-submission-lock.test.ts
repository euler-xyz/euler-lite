import { describe, expect, it } from 'vitest'
import { acquireSafeSubmissionLock } from '~/utils/safe-submission-lock'

describe('Safe submission cross-tab lock', () => {
  it('blocks a concurrent lifecycle until the owner releases it', async () => {
    const releaseFirst = await acquireSafeSubmissionLock()

    await expect(acquireSafeSubmissionLock()).rejects.toThrow('Another tab is already managing a Safe submission')

    releaseFirst()
    await Promise.resolve()
    const releaseSecond = await acquireSafeSubmissionLock()
    releaseSecond()
  })

  it('fails closed when the browser cannot coordinate tabs', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    })

    await expect(acquireSafeSubmissionLock()).rejects.toThrow('Cross-tab Safe submission locking is unavailable')
  })
})
