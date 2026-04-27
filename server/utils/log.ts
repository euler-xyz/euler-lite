import { logger } from '~/server/utils/logger'

/**
 * Transition-based status logger for warm-cache upstream probes.
 *
 * Warm cycles hit the same upstreams every few minutes. If one is persistently
 * returning 403, logging the failure on every cycle buries genuine signal in
 * steady-state noise. reportStatus remembers the last-reported status for a
 * (context, key) pair and logs ONLY when the status changes:
 *
 *   - first observation of an error → WARN
 *   - error → different error         → WARN (with prior status in the message)
 *   - error → ok                      → INFO recovery
 *   - ok → ok                         → silent
 *   - error → same error              → silent
 *
 * Callers pass a short `status` string (e.g. 'ok', 'http-403', 'timeout') and
 * an optional human-readable message. The status string is what's compared for
 * transitions; the message is what gets printed.
 *
 * Process-local state — restarts reset the history, which is fine: the first
 * cycle after a restart will re-log any persistent errors.
 */
const lastStatus = new Map<string, string>()

export function reportStatus(
  context: string,
  key: string,
  status: string,
  message?: string,
): void {
  const fullKey = `${context}:${key}`
  const prev = lastStatus.get(fullKey)
  if (prev === status) return
  lastStatus.set(fullKey, status)

  if (status === 'ok') {
    if (prev && prev !== 'ok') {
      logger.info({ ctx: context, key, status, prevStatus: prev }, `${key} recovered`)
    }
    return
  }

  logger.warn(
    { ctx: context, key, status, ...(prev && prev !== 'ok' ? { prevStatus: prev } : {}) },
    message ?? `${key} status=${status}`,
  )
}
