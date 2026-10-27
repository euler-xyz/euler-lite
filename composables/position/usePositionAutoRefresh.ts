import { useVisibleTicker } from '~/composables/useVisibleTicker'

/** Refreshes an open position on the visible tick, except while the user builds, simulates or sends a change. */
export const usePositionAutoRefresh = ({ isBusy, reread }: {
  isBusy: () => boolean
  reread: () => Promise<void>
}) => {
  const { refreshAllPositions } = useEulerAccount()
  const { refresh: refreshFreshAccount } = useFreshAccount()
  const { entryCount, isSimulating } = useTxBatch()
  const canRefresh = () => entryCount.value === 0 && !isSimulating.value && !isBusy()

  return useVisibleTicker([async () => {
    if (!canRefresh()) return
    refreshFreshAccount()
    await refreshAllPositions()
    if (canRefresh()) await reread()
  }])
}
