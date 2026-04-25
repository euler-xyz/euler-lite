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
 * Vite/Nitro replaces `import.meta.server` with a literal at build time, so
 * the dynamic `import('./logger.server')` is dead-code-eliminated from the
 * client bundle and pino never ships to the browser. Verified via the bundle
 * grep in `tests/utils/logger.test.ts` plus the explicit check in CI.
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
