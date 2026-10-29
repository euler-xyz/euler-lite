import { getCurrentScope, onScopeDispose } from 'vue'
import { useVisibleTicker } from '~/composables/useVisibleTicker'

/** Refreshes an open position on the visible tick, except while the user builds, simulates or sends a change. */
export const usePositionAutoRefresh = ({ isBusy, reread }: {
  isBusy: () => boolean
  reread: () => Promise<void>
}) => {
  const { refreshAllPositions } = useEulerAccount()
  const { refresh: refreshFreshAccount } = useFreshAccount()
  const { entryCount, isSimulating } = useTxBatch()
  let disposed = false
  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true
  })
  const canRefresh = () => !disposed && entryCount.value === 0 && !isSimulating.value && !isBusy()

  return useVisibleTicker([async () => {
    if (!canRefresh()) return
    refreshFreshAccount()
    let result = await refreshAllPositions()
    while (result === 'cancelled' && canRefresh() && document.visibilityState === 'visible') {
      result = await refreshAllPositions()
    }
    if (result !== 'cancelled' && canRefresh()) await reread()
  }])
}
