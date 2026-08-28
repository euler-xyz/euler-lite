const SAFE_REVIEWED_SUBMISSION_LOCK_NAME = 'euler-lite:safe-reviewed-submission-storage'

/**
 * Serialize the read-modify-write sections of Safe submission persistence
 * across browser tabs. Durable records survive reloads; the Web Lock closes
 * the live-tab race where two tabs could otherwise both observe no record.
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
