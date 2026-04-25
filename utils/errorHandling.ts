import { logger } from '~/utils/logger'

type LogSeverity = 'warn' | 'error' | 'silent'

/**
 * Detects AbortError (DOMException) and CanceledError (Axios).
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: string }).name
    return name === 'AbortError' || name === 'CanceledError'
  }
  return false
}

/**
 * Legacy structured-warning shim. New call sites should call `logger.warn` /
 * `logger.error` directly with a fields object — that way `chainId`, `kind`,
 * etc. are first-class JSON fields in BetterStack. This wrapper exists so
 * the long tail of pre-existing call sites still benefit from the pino
 * pipeline (one JSON line per event, viem error summarisation) without a
 * mass rewrite.
 *
 * @deprecated Prefer `logger.warn({ ctx, ...chainTag(chainId), ... }, 'msg')`.
 */
export function logWarn(
  context: string,
  error: unknown,
  options?: { severity?: LogSeverity, data?: unknown },
): void {
  const severity = options?.severity ?? 'warn'
  if (severity === 'silent') return

  const fields: Record<string, unknown> = { ctx: context }
  if (options?.data !== undefined) fields.data = options.data
  if (error instanceof Error) {
    fields.err = error
    const log = severity === 'error' ? logger.error : logger.warn
    log(fields, error.message)
    return
  }
  const msg = typeof error === 'string' ? error : ''
  const log = severity === 'error' ? logger.error : logger.warn
  if (msg) log(fields, msg)
  else log({ ...fields, value: error }, '')
}

/**
 * Runs an async function and returns a fallback value on error.
 *
 * @param fn - Async function to execute
 * @param fallback - Value to return if fn throws
 * @param logContext - If provided, logs the error via logWarn with this context
 */
export async function catchToFallback<T>(
  fn: () => Promise<T>,
  fallback: T,
  logContext?: string,
): Promise<T> {
  try {
    return await fn()
  }
  catch (err) {
    if (logContext) {
      logWarn(logContext, err)
    }
    return fallback
  }
}
