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

type JsonSafeValue = null | string | number | boolean | JsonSafeValue[] | { [key: string]: JsonSafeValue }
const CLASS_INSTANCE_SCALAR_KEYS = ['name', 'message', 'status', 'statusText', 'code', 'url'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const projectClassInstance = (value: object): { [key: string]: JsonSafeValue } => {
  const record = value as Record<string, unknown>
  const out: { [key: string]: JsonSafeValue } = {
    type: value.constructor?.name || Object.prototype.toString.call(value),
  }

  for (const key of CLASS_INSTANCE_SCALAR_KEYS) {
    const nested = record[key]
    if (
      typeof nested === 'string'
      || typeof nested === 'number'
      || typeof nested === 'boolean'
      || typeof nested === 'bigint'
    ) {
      out[key] = typeof nested === 'bigint' ? nested.toString() : nested
    }
  }

  return out
}

const projectValue = (value: unknown, seen: WeakSet<object>): JsonSafeValue | undefined => {
  if (value instanceof Error) return summarizeViemError(value) as unknown as JsonSafeValue
  if (value == null) return null

  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 'NaN' : value
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function' || typeof value === 'undefined') return undefined

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = value.map(item => projectValue(item, seen) ?? null)
    seen.delete(value)
    return out
  }

  if (value instanceof Date) return value.toISOString()

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (!isPlainObject(value)) {
      seen.delete(value)
      return projectClassInstance(value)
    }

    const out: { [key: string]: JsonSafeValue } = {}
    for (const [key, nested] of Object.entries(value)) {
      const projected = projectValue(nested, seen)
      if (projected !== undefined) out[key] = projected
    }
    seen.delete(value)
    return out
  }

  return String(value)
}

/**
 * Recursively projects log fields into JSON-safe values. Any nested `Error`
 * is summarised, `bigint`s are stringified, and cycles are marked instead of
 * letting logging throw from JSON.stringify.
 */
const projectFields = (fields: Fields): Fields => {
  const out: Fields = {}
  const seen = new WeakSet<object>()
  for (const [key, value] of Object.entries(fields)) {
    const projected = projectValue(value, seen)
    if (projected !== undefined) out[key] = projected
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
