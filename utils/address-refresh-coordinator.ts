export function createAddressRefreshCoordinator(onPreempt?: () => void) {
  let inFlightAddress: string | null = null
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
    return true
  }

  const finish = async (targetAddress: string, rerun: () => Promise<void>) => {
    const ownsInFlight = inFlightAddress === targetAddress
    const shouldRerun = ownsInFlight && queuedRefreshAddress === targetAddress
    if (ownsInFlight) inFlightAddress = null
    if (shouldRerun) {
      queuedRefreshAddress = null
      await rerun()
    }
  }

  const reset = () => {
    inFlightAddress = null
    queuedRefreshAddress = null
  }

  return {
    begin,
    finish,
    reset,
  }
}
