// Lightweight perf tracer. Emits a single console line per measured span with
// a [PROF] prefix so Playwright / DevTools console capture is grep-friendly.
// Concurrent spans (parallel quotes) share a `flow` tag so timings can be
// reassembled offline. No-op outside the browser to keep SSR untouched.

import { profOptIn } from './debug-flags'

declare global {
  interface Window {
    __EULER_PROF__?: {
      enabled: boolean
      events: Array<{ t: number, flow: string, label: string, dur: number, meta?: Record<string, unknown> }>
    }
  }
}

const isBrowser = typeof window !== 'undefined'

const ensureStore = () => {
  if (!isBrowser) return null
  const w = window
  if (!w.__EULER_PROF__) {
    // Off on regular runs; opt in with `?prof` / `localStorage.euler_prof=1`
    // (or flip `window.__EULER_PROF__.enabled` in DevTools).
    w.__EULER_PROF__ = { enabled: profOptIn, events: [] }
  }
  return w.__EULER_PROF__
}

export const profEnabled = (): boolean => {
  const store = ensureStore()
  return !!store?.enabled
}

export const profMark = (flow: string, label: string, meta?: Record<string, unknown>) => {
  if (!profEnabled()) return
  // eslint-disable-next-line no-console
  console.log(`[PROF] ${flow} | ${label} @${performance.now().toFixed(1)}ms`, meta ?? '')
}

export async function profAsync<T>(
  flow: string,
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  if (!profEnabled()) return fn()
  const store = ensureStore()
  const t0 = performance.now()
  try {
    return await fn()
  }
  finally {
    const dur = performance.now() - t0
    store?.events.push({ t: t0, flow, label, dur, meta })
    // eslint-disable-next-line no-console
    console.log(`[PROF] ${flow} | ${label} = ${dur.toFixed(1)}ms`, meta ?? '')
  }
}

let flowCounter = 0
export const newProfFlow = (prefix: string) => {
  flowCounter += 1
  return `${prefix}#${flowCounter}`
}
