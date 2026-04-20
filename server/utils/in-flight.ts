import { logWarn } from './log'

export { createInFlightDedup, type InFlightDedup } from '~/utils/in-flight'

/**
 * Fire-and-forget background refresh. Used by SWR handlers when serving
 * stale: kick the refresh, swallow the rejection (logWarn for
 * observability), return the stale payload synchronously so no user
 * waits on the refresh.
 */
export function scheduleBackgroundRefresh(context: string, refresh: () => Promise<unknown>): void {
  void refresh().catch((err) => {
    logWarn(context, `background refresh failed:`, err instanceof Error ? err.message : err)
  })
}
