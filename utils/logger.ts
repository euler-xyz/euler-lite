/**
 * Shared structured-logger entry point.
 *
 * `utils/logger.ts` is the import path used by code that runs in **both**
 * server and client contexts (everything under `entities/`, `services/`, and
 * the cross-cutting helpers in `utils/`). It re-exports the lightweight
 * console shim from `./logger.client` unconditionally, with no top-level
 * await and no dynamic imports — Node 24 + Nitro emit a hard
 * "unsettled top-level await" warning when a chunk's TLA doesn't resolve by
 * startup, and that path was firing once per module that imported `logger`.
 *
 * Server-only modules (`server/api/**`, `server/middleware/**`,
 * `server/plugins/**`, `server/utils/**`) import `~/utils/logger.server`
 * directly to get the pino instance with JSON output, level filtering, and
 * `pino-pretty` in dev. They never need the cross-context guard.
 *
 * Why the shim is sufficient for code that runs on the server via the
 * shared path: the client shim emits via `console.warn(prefix, msg, fields)`
 * with a flat ≤8-field object. Node's `util.inspect` keeps that on a single
 * line (well under the default `breakLength` of 128), and Fargate captures
 * one stderr line per `console.*` call — i.e. one BetterStack row per
 * logical event. The 568-row incident was specifically caused by passing
 * the raw, deeply-nested viem error object to `console.error`, which we
 * no longer do anywhere.
 */
export { logger } from './logger.client'
export type { Logger } from './logger.client'
