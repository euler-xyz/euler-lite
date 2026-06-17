// Browser-only opt-in flags for diagnostics that are silenced on regular runs.
//
// Regular runs stay quiet: the perf tracer is off and the client logger only
// emits `error`/`fatal`. Instrumented runs (Playwright parity captures, manual
// debugging) opt back in per flag, either via a URL query param or a
// `localStorage` key set to "1". SSR-safe — always false on the server.
//
// Flags are read once at module load (cheap, and these sit on hot paths), so
// toggling localStorage requires a reload. A query param is honoured on the
// first load of the session.

const isBrowser = typeof window !== 'undefined'

const readFlag = (queryKey: string, storageKey: string): boolean => {
  if (!isBrowser) return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.has(queryKey)) {
      const v = params.get(queryKey)
      return v !== '0' && v !== 'false'
    }
    return window.localStorage?.getItem(storageKey) === '1'
  }
  catch {
    return false
  }
}

/** Perf tracer (`utils/profiler.ts`). Opt in with `?prof` or `localStorage.euler_prof=1`. */
export const profOptIn: boolean = readFlag('prof', 'euler_prof')

/** Verbose client logging — restores `warn`/`info`/`debug`. Opt in with `?verbose` or `localStorage.euler_verbose=1`. */
export const verboseLogsOptIn: boolean = readFlag('verbose', 'euler_verbose')

/** Disables list windowing so every row stays mounted. Needed by parity
 * captures, which scrape the full list DOM. Opt in with `?fullrender` or
 * `localStorage.euler_full_render=1`. */
export const fullListRenderOptIn: boolean = readFlag('fullrender', 'euler_full_render')
