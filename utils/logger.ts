import { summarizeViemError } from './viem-errors'

/**
 * Shared structured-logger entry point.
 *
 * Used by code that runs in **both** server and client contexts (everything
 * under `entities/`, `services/`, and the cross-cutting helpers in `utils/`).
 * Emits via `console.*` with a flat field object so a single call produces
 * exactly one stderr line under Node — Fargate then ships one BetterStack
 * row per logical event. The shim does not ship pino; that would balloon
 * the client bundle for no benefit, since browser logs go to DevTools and
 * not to BetterStack.
 *
 * Server-only modules (`server/api/**`, `server/middleware/**`,
 * `server/plugins/**`, `server/utils/**`) import from `~/server/utils/logger`
 * instead to get the pino instance with JSON output, level filtering, and
 * `pino-pretty` in dev.
 *
 * Field shape mirrors pino: `(fields, msg)` with optional bindings via
 * `child(bindings)`. Errors passed in `err` / `error` are summarised so we
 * never log raw viem errors with their `abi` / `metaMessages` payloads.
 */

type Fields = Record<string, unknown>
type LogMethod = (fields: Fields | string, msg?: string) => void

export type Logger = {
  level: string
  trace: LogMethod
  debug: LogMethod
  info: LogMethod
  warn: LogMethod
  error: LogMethod
  fatal: LogMethod
  child: (bindings: Fields) => Logger
}

const summariseErr = (value: unknown): unknown => {
  if (value == null) return value
  if (value instanceof Error) return summarizeViemError(value)
  return value
}

const projectFields = (fields: Fields): Fields => {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = key === 'err' || key === 'error' ? summariseErr(value) : value
  }
  return out
}

const formatPrefix = (fields: Fields): string => {
  const ctx = typeof fields.ctx === 'string' ? fields.ctx : undefined
  const chainId = typeof fields.chainId === 'number' ? fields.chainId : undefined
  const tag = chainId != null ? ` (chainId=${chainId})` : ''
  return ctx ? `[${ctx}]${tag}` : `[log]${tag}`
}

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error'

const make = (bindings: Fields): Logger => {
  // Look up console.* at call time, not module load, so test spies and any
  // userland console replacement (Sentry breadcrumbs etc.) take effect. The
  // eslint-disable directives on debug/info are intentional: this shim is the
  // single sanctioned bridge from our structured-logging API to browser
  // DevTools, and we want trace/debug/info entries to remain visible at their
  // natural verbosity rather than collapsing onto warn.
  const emit = (method: ConsoleMethod) =>
    (fieldsOrMsg: Fields | string, msg?: string): void => {
      if (typeof fieldsOrMsg === 'string') {
        // eslint-disable-next-line no-console
        console[method](formatPrefix(bindings), fieldsOrMsg)
        return
      }
      const fields = projectFields({ ...bindings, ...fieldsOrMsg })
      // eslint-disable-next-line no-console
      console[method](formatPrefix(fields), msg ?? '', fields)
    }

  return {
    level: 'debug',
    trace: emit('debug'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('error'),
    child: (extra: Fields) => make({ ...bindings, ...extra }),
  }
}

export const logger: Logger = make({})
