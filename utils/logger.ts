import { summarizeViemError } from './viem-errors'

/**
 * Shared structured logger.
 *
 * Used by code that runs in **both** server and client contexts (everything
 * under `entities/`, `services/`, and the cross-cutting helpers in `utils/`).
 *
 * - **On the client (browser)** emits via `console.*` so logs surface in
 *   DevTools and Sentry breadcrumb hooks intercept them.
 * - **On the server (Node)** emits a single JSON line per call to stdout.
 *   Fargate ships every stdout line as one BetterStack row, and the JSON
 *   shape matches the pino logger in `~/server/utils/logger` so structured
 *   queries (`chainId`, `kind`, etc.) work uniformly across both code paths.
 *
 * Server-only modules (`server/api/**`, `server/middleware/**`,
 * `server/plugins/**`, `server/utils/**`) import from `~/server/utils/logger`
 * directly to get the pino instance — that's the canonical server logger.
 *
 * Field shape mirrors pino: `(fields, msg)` with optional bindings via
 * `child(bindings)`. Any field whose value is an `Error` gets summarised
 * via `summarizeViemError`, so raw viem errors never leak `abi`,
 * `metaMessages`, or `args`.
 */

type Fields = Record<string, unknown>
type LogMethod = (fields: Fields | string, msg?: string) => void

export type Logger = {
  trace: LogMethod
  debug: LogMethod
  info: LogMethod
  warn: LogMethod
  error: LogMethod
  fatal: LogMethod
  child: (bindings: Fields) => Logger
}

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const summariseValue = (value: unknown): unknown =>
  value instanceof Error ? summarizeViemError(value) : value

/**
 * Walks ALL keys (not just `err` / `error`) and replaces any `Error` value
 * with its summary. Anchors the safety property — "viem internals never
 * reach the log sink" — to the value type, not to a key-name convention.
 */
const projectFields = (fields: Fields): Fields => {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = summariseValue(value)
  }
  return out
}

const formatPrefix = (fields: Fields): string => {
  const ctx = typeof fields.ctx === 'string' ? fields.ctx : undefined
  const chainId = typeof fields.chainId === 'number' ? fields.chainId : undefined
  const tag = chainId != null ? ` (chainId=${chainId})` : ''
  return ctx ? `[${ctx}]${tag}` : `[log]${tag}`
}

const isNode = typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node != null

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error'

const consoleMethodFor = (level: Level): ConsoleMethod => {
  if (level === 'trace' || level === 'debug') return 'debug'
  if (level === 'info') return 'info'
  if (level === 'warn') return 'warn'
  return 'error' // error, fatal
}

const emitNode = (level: Level, fields: Fields, msg: string | undefined): void => {
  // JSON shape mirrors `~/server/utils/logger` so BetterStack queries on
  // `level`, `ctx`, `chainId`, `kind` work uniformly across the two code
  // paths. `time` is ms-since-epoch (matches pino's default).
  const line = JSON.stringify({
    level,
    time: Date.now(),
    app: 'euler-lite',
    ...projectFields(fields),
    msg: msg ?? '',
  })
  process.stdout.write(line + '\n')
}

const emitBrowser = (level: Level, fields: Fields, msg: string | undefined): void => {
  const method = consoleMethodFor(level)
  // Look up console.* at call time, not module load, so test spies and any
  // userland console replacement (Sentry breadcrumbs etc.) take effect.
  // eslint-disable-next-line no-console
  console[method](formatPrefix(fields), msg ?? '', projectFields(fields))
}

const make = (bindings: Fields): Logger => {
  const emit = (level: Level): LogMethod =>
    (fieldsOrMsg: Fields | string, msg?: string): void => {
      const incoming: Fields = typeof fieldsOrMsg === 'string' ? bindings : { ...bindings, ...fieldsOrMsg }
      const message = typeof fieldsOrMsg === 'string' ? fieldsOrMsg : msg
      if (isNode) emitNode(level, incoming, message)
      else emitBrowser(level, incoming, message)
    }

  return {
    trace: emit('trace'),
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    fatal: emit('fatal'),
    child: (extra: Fields) => make({ ...bindings, ...extra }),
  }
}

export const logger: Logger = make({})
