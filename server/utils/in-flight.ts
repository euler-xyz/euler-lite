import { reportStatus } from './log'

export { createInFlightDedup, type InFlightDedup } from '~/utils/in-flight'

/**
 * Fire-and-forget background refresh. Used by SWR handlers when serving
 * stale: kick the refresh, swallow the rejection, return the stale
 * payload synchronously so no user waits on the refresh.
 *
 * Uses reportStatus for transition-based dedup — repeated failures
 * against the same context only log once until the status changes.
 */
export function scheduleBackgroundRefresh(context: string, refresh: () => Promise<unknown>): void {
  void refresh().then(
    () => { reportStatus(context, 'bg-refresh', 'ok') },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus(context, 'bg-refresh', `failed:${msg}`, `background refresh failed: ${msg}`)
    },
  )
}
