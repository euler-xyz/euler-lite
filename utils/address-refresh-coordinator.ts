export type AddressRefreshResult = 'completed' | 'cancelled'

export function createAddressRefreshCoordinator(onPreempt?: () => void) {
  let inFlightAddress: string | null = null
  let inFlightToken: symbol | null = null
  let queuedRefresh: { promise: Promise<AddressRefreshResult>, resolve: (result: AddressRefreshResult) => void } | null = null
  // Queued callers remain cancellable while their rerun (or a later rerun) is running.
  const pendingWaiters = new Set<(result: AddressRefreshResult) => void>()
  const releaseWaiters = () => {
    pendingWaiters.forEach(resolve => resolve('cancelled'))
    pendingWaiters.clear()
    queuedRefresh = null
  }

  const begin = (targetAddress: string) => {
    if (inFlightAddress === targetAddress) {
      if (!queuedRefresh) {
        let resolve!: (result: AddressRefreshResult) => void
        const promise = new Promise<AddressRefreshResult>((resolvePromise) => {
          resolve = resolvePromise
        })
        pendingWaiters.add(resolve)
        queuedRefresh = {
          promise,
          resolve: (result) => {
            pendingWaiters.delete(resolve)
            resolve(result)
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

  const finish = async (token: symbol, rerun: () => Promise<AddressRefreshResult>): Promise<AddressRefreshResult> => {
    if (inFlightToken !== token) return 'cancelled'

    const queued = queuedRefresh
    inFlightAddress = null
    inFlightToken = null
    queuedRefresh = null
    if (!queued) return 'completed'

    let result: AddressRefreshResult = 'completed'
    try {
      // Reset and preemption release the original caller as well as queued callers.
      result = await Promise.race([
        rerun(),
        queued.promise,
      ])
      return result
    }
    finally {
      queued.resolve(result)
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
