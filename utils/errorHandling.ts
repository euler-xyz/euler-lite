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
 * Compact `(context, error)` warning helper for client-side call sites.
 *
 * Routes through the shared `logger` so the output goes through the same
 * structured pipeline as direct `logger.warn` calls (one console line per
 * event, errors summarised via `summarizeViemError` so `abi`/`metaMessages`
 * payloads never leak). Server-side code should call `logger.warn({ ctx, ... }, 'msg')`
 * directly.
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
