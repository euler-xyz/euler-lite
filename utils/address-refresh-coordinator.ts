export function createAddressRefreshCoordinator(onPreempt?: () => void) {
  let inFlightAddress: string | null = null
  let inFlightToken: symbol | null = null
  let queuedRefresh: { promise: Promise<void>, resolve: () => void } | null = null
  // Queued callers remain cancellable while their rerun (or a later rerun) is running.
  const pendingWaiters = new Set<() => void>()
  const releaseWaiters = () => {
    pendingWaiters.forEach(resolve => resolve())
    pendingWaiters.clear()
    queuedRefresh = null
  }

  const begin = (targetAddress: string) => {
    if (inFlightAddress === targetAddress) {
      if (!queuedRefresh) {
        let resolve!: () => void
        const promise = new Promise<void>((resolvePromise) => {
          resolve = resolvePromise
        })
        pendingWaiters.add(resolve)
        queuedRefresh = {
          promise,
          resolve: () => {
            pendingWaiters.delete(resolve)
            resolve()
          },
        }
      }
      return queuedRefresh.promise
    }
    if (inFlightAddress !== null) {
      onPreempt?.()
      releaseWaiters()
    }
    inFlightAddress = targetAddress
    inFlightToken = Symbol()
    return inFlightToken
  }

  const finish = async (token: symbol, rerun: () => Promise<void>) => {
    if (inFlightToken !== token) return

    const queued = queuedRefresh
    inFlightAddress = null
    inFlightToken = null
    queuedRefresh = null
    if (queued) {
      try {
        await rerun()
      }
      finally {
        queued.resolve()
      }
    }
  }

  const reset = () => {
    inFlightAddress = null
    inFlightToken = null
    releaseWaiters()
  }

  return {
    begin,
    finish,
    reset,
  }
}
