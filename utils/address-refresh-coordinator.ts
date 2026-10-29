export function createAddressRefreshCoordinator(onPreempt?: () => void) {
  let inFlightAddress: string | null = null
  let inFlightToken: symbol | null = null
  let queuedRefresh: { promise: Promise<void>, resolve: () => void } | null = null

  const begin = (targetAddress: string) => {
    if (inFlightAddress === targetAddress) {
      if (!queuedRefresh) {
        let resolve!: () => void
        const promise = new Promise<void>((resolvePromise) => {
          resolve = resolvePromise
        })
        queuedRefresh = { promise, resolve }
      }
      return queuedRefresh.promise
    }
    if (inFlightAddress !== null) {
      onPreempt?.()
      queuedRefresh?.resolve()
      queuedRefresh = null
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
    queuedRefresh?.resolve()
    queuedRefresh = null
  }

  return {
    begin,
    finish,
    reset,
  }
}
