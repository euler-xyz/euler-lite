export function createAddressRefreshCoordinator(onPreempt?: () => void) {
  let inFlightAddress: string | null = null
  let inFlightToken: symbol | null = null
  let queuedRefreshAddress: string | null = null

  const begin = (targetAddress: string) => {
    if (inFlightAddress === targetAddress) {
      queuedRefreshAddress = targetAddress
      return false
    }
    if (inFlightAddress !== null) {
      onPreempt?.()
      queuedRefreshAddress = null
    }
    inFlightAddress = targetAddress
    inFlightToken = Symbol()
    return inFlightToken
  }

  const finish = async (token: symbol, rerun: () => Promise<void>) => {
    const ownsInFlight = inFlightToken === token
    const shouldRerun = ownsInFlight && queuedRefreshAddress === inFlightAddress
    if (ownsInFlight) {
      inFlightAddress = null
      inFlightToken = null
    }
    if (shouldRerun) {
      queuedRefreshAddress = null
      await rerun()
    }
  }

  const reset = () => {
    inFlightAddress = null
    inFlightToken = null
    queuedRefreshAddress = null
  }

  return {
    begin,
    finish,
    reset,
  }
}
