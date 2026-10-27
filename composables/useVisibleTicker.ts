import { getCurrentScope, onScopeDispose } from 'vue'
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'

export type VisibleTickerTask = () => unknown

/**
 * Runs each task every interval while the tab is visible. A hidden tab runs nothing; when it is
 * shown again or gets focus, every task whose last run started a full interval ago runs at once.
 * A task whose previous run has not finished is not started again.
 */
export const useVisibleTicker = (
  tasks: readonly VisibleTickerTask[],
  intervalMs = POLL_INTERVAL_60S_MS,
) => {
  const lastStartedAt = new Map<VisibleTickerTask, number>()
  const running = new Set<VisibleTickerTask>()
  let timer: ReturnType<typeof setInterval> | undefined

  const run = async (task: VisibleTickerTask) => {
    running.add(task)
    try {
      await task()
    }
    catch (error) {
      logWarn('useVisibleTicker', error)
    }
    finally {
      running.delete(task)
    }
  }

  const runDue = (minAgeMs: number) => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    tasks
      .filter(task => !running.has(task) && now - (lastStartedAt.get(task) ?? 0) >= minAgeMs)
      .forEach((task) => {
        lastStartedAt.set(task, now)
        void run(task)
      })
  }

  // A tick needs only half an interval, so timer drift never skips one; showing the tab needs a
  // full interval, so it adds no run right after a tick.
  const onTick = () => runDue(intervalMs / 2)
  const onShown = () => runDue(intervalMs)

  const start = () => {
    if (timer) return
    const now = Date.now()
    tasks.forEach(task => lastStartedAt.set(task, now))
    timer = setInterval(onTick, intervalMs)
    window.addEventListener('focus', onShown)
    document.addEventListener('visibilitychange', onShown)
  }

  const stop = () => {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
    window.removeEventListener('focus', onShown)
    document.removeEventListener('visibilitychange', onShown)
  }

  if (getCurrentScope()) onScopeDispose(stop)

  return { start, stop }
}
