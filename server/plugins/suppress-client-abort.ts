/**
 * Suppress H3Error: aborted from client disconnections.
 *
 * When a browser navigates away, closes a tab, or loses connectivity while
 * the server is still processing the request (reading the body, awaiting an
 * upstream fetch, etc.), Node's IncomingMessage emits an "error" event with
 * a plain `Error("aborted")`. H3's readRawBody rejects with that error,
 * which bubbles up and gets wrapped by h3 into `H3Error("aborted")` with
 * `unhandled: true` (because the original was not an H3Error).
 *
 * Both H3 and Nitro's default error handler log unhandled errors to stderr,
 * which inflates error-rate metrics and triggers false-positive alerts.
 * These are normal in production traffic and not actionable.
 *
 * This plugin runs synchronously inside Nitro's `captureError` path —
 * before either the Nitro error handler or H3's own unhandled-error log
 * execute — so flipping `unhandled` to `false` suppresses both.
 */
import { isError as isH3Error } from 'h3'

function isClientAbort(error: unknown): boolean {
  if (!isH3Error(error)) return false
  // H3 wraps the raw Error as the message; statusMessage stays undefined
  if (error.message === 'aborted') return true
  // Defensive: also match if statusMessage was set (future h3 versions)
  if (error.statusMessage === 'aborted') return true
  return false
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error) => {
    if (isClientAbort(error as Error)) {
      // Mark handled so neither Nitro's errorHandler nor H3's own
      // unhandled-error path logs to stderr.
      (error as { unhandled?: boolean }).unhandled = false
    }
  })
})
