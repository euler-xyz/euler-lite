import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVisibleTicker } from '~/composables/useVisibleTicker'

const INTERVAL = 60_000

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let doc: EventTarget & { visibilityState: DocumentVisibilityState }
let win: EventTarget

const setVisibility = (state: DocumentVisibilityState) => {
  doc.visibilityState = state
  doc.dispatchEvent(new Event('visibilitychange'))
}

describe('useVisibleTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    win = new EventTarget()
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', win)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs every task once per interval while the tab is visible', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const ticker = useVisibleTicker([first, second], INTERVAL)
    ticker.start()

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)
    expect(first).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(first).toHaveBeenCalledTimes(2)
    ticker.stop()
  })

  it('runs nothing while the tab is hidden', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    setVisibility('hidden')

    await vi.advanceTimersByTimeAsync(5 * INTERVAL)
    expect(task).not.toHaveBeenCalled()
    ticker.stop()
  })

  it('runs at once when the tab is shown again after a full interval', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(3 * INTERVAL)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    ticker.stop()
  })

  it('runs at once on focus after a full interval', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    doc.visibilityState = 'visible'

    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    ticker.stop()
  })

  it('does not run again when the tab is shown within an interval of the last run', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(task).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(INTERVAL / 2)
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    ticker.stop()
  })

  it('does not run a tick right after the tab was shown and ran the tasks', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(INTERVAL + INTERVAL - 5_000)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(task).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(task).toHaveBeenCalledTimes(2)
    ticker.stop()
  })

  it('does not start a task again while its previous run is still going', async () => {
    const slow = deferred()
    const task = vi.fn(() => slow.promise)
    const other = vi.fn()
    const ticker = useVisibleTicker([task, other], INTERVAL)
    ticker.start()

    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    expect(task).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(2)

    slow.resolve()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(task).toHaveBeenCalledTimes(2)
    ticker.stop()
  })

  it('keeps running after a task fails', async () => {
    const failing = vi.fn(() => {
      throw new Error('read failed')
    })
    const rejecting = vi.fn(() => Promise.reject(new Error('read failed')))
    const ticker = useVisibleTicker([failing, rejecting], INTERVAL)
    ticker.start()

    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    expect(failing).toHaveBeenCalledTimes(2)
    expect(rejecting).toHaveBeenCalledTimes(2)
    ticker.stop()
  })

  it('stops the timer and the listeners on stop and when its scope ends', async () => {
    const stopped = vi.fn()
    const ticker = useVisibleTicker([stopped], INTERVAL)
    ticker.start()
    ticker.stop()

    const scoped = vi.fn()
    const scope = effectScope()
    scope.run(() => useVisibleTicker([scoped], INTERVAL).start())
    scope.stop()

    await vi.advanceTimersByTimeAsync(3 * INTERVAL)
    setVisibility('visible')
    win.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).not.toHaveBeenCalled()
    expect(scoped).not.toHaveBeenCalled()
  })

  it('starts once when started twice', async () => {
    const task = vi.fn()
    const ticker = useVisibleTicker([task], INTERVAL)
    ticker.start()
    ticker.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(task).toHaveBeenCalledTimes(1)
    ticker.stop()
  })
})
