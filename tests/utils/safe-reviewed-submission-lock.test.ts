import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSafeReviewedSubmissionLock } from '~/utils/safe-reviewed-submission-lock'

describe('Safe reviewed-submission cross-tab lock', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('blocks a concurrent lifecycle until the owner releases it', async () => {
    const releaseFirst = await acquireSafeReviewedSubmissionLock()

    await expect(acquireSafeReviewedSubmissionLock()).rejects.toThrow('Another tab is already managing a Safe submission')

    releaseFirst()
    await Promise.resolve()
    const releaseSecond = await acquireSafeReviewedSubmissionLock()
    releaseSecond()
  })

  it('fails closed when the browser cannot coordinate tabs', async () => {
    vi.stubGlobal('navigator', {})

    await expect(acquireSafeReviewedSubmissionLock()).rejects.toThrow('Cross-tab Safe submission locking is unavailable')
  })
})
