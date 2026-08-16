const SAFE_SUBMISSION_LOCK_NAME = 'euler-lite:safe-submission-storage'

/**
 * Hold one browser-wide Safe submission lifecycle at a time. Durable records
 * survive reloads; this lock prevents live tabs from racing their storage
 * refresh and write sequence and erasing one another's reservation.
 */
export const acquireSafeSubmissionLock = async (): Promise<() => void> => {
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
    SAFE_SUBMISSION_LOCK_NAME,
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
