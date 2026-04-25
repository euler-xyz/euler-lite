import type { Logger } from './logger.client'

/**
 * Environment-aware structured logger.
 *
 * - On the **server** (Nitro / Node) this resolves to a `pino` instance that
 *   emits one JSON line per event to stdout — what the Fargate container
 *   ships to BetterStack.
 * - On the **client** it resolves to a tiny console shim with the same
 *   `(fields, msg)` API so call-site code is identical in both contexts.
 *
 * Vite/Nitro replaces `import.meta.server` with a literal at build time, and
 * the dynamic `import()` inside the dead `if (false)` branch becomes
 * unreachable code that Rollup eliminates from the client bundle. Verified
 * empirically by `tests/utils/logger-bundle.test.ts`, which runs against the
 * built `.output/public/_nuxt/` and asserts that none of pino's server-only
 * dependencies (`pino-pretty`, `pino-std-serializers`, our own
 * `logger.server` chunk) reach the client.
 *
 * Note on `await`: top-level `await` here makes every importer of `logger`
 * async at module init time. That's tolerable given how few modules import
 * this directly (most go through the auto-imported global) and because the
 * alternative — a synchronous lazy proxy — leaks the resolution model into
 * every call site. If hot-path init time becomes a concern, pin the server
 * runtime to import `~/utils/logger.server` directly and demote this entry
 * to a client-only re-export.
 */

let resolved: Logger
if (import.meta.server) {
  resolved = (await import('./logger.server')).logger as unknown as Logger
}
else {
  resolved = (await import('./logger.client')).logger
}

export const logger = resolved
export type { Logger }
