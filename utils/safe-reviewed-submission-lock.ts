const SAFE_REVIEWED_SUBMISSION_LOCK_NAME = 'euler-lite:safe-reviewed-submission-storage'

/**
 * Serialize Safe submission persistence across browser tabs. The dispatch
 * adapter retains the acquired lock across its wallet handoff, while smaller
 * reconciliation and manual-clear mutations use it for one operation.
 */
export const acquireSafeReviewedSubmissionLock = async (): Promise<() => void> => {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error('Cross-tab Safe submission locking is unavailable; Safe submission was blocked')
  }

  let resolveAcquisition!: (release: (() => void) | undefined) => void
  let rejectAcquisition!: (error: unknown) => void
  const acquisition = new Promise<(() => void) | undefined>((resolve, reject) => {
    resolveAcquisition = resolve
    rejectAcquisition = reject
  })

  const request = navigator.locks.request(
    SAFE_REVIEWED_SUBMISSION_LOCK_NAME,
    { mode: 'exclusive', ifAvailable: true },
    (lock) => {
      if (!lock) {
        resolveAcquisition(undefined)
        return
      }
      return new Promise<void>((release) => {
        let released = false
        resolveAcquisition(() => {
          if (released) return
          released = true
          release()
        })
      })
    },
  )
  void request.catch(rejectAcquisition)

  const release = await acquisition
  if (!release) {
    throw new Error('Another tab is already managing a Safe submission. Finish or reconcile it there before retrying.')
  }
  return release
}

export const withSafeReviewedSubmissionLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  const release = await acquireSafeReviewedSubmissionLock()
  try {
    return await operation()
  }
  finally {
    release()
  }
}
