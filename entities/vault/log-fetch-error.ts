import { logWarn } from '~/utils/errorHandling'

/**
 * Shared concise-log helper for vault fetchers. Detects the two classes of
 * "expected operational noise" and prints a one-line warn instead of the
 * viem error's full nested-cause stack trace (which easily fills 30+ lines
 * in server dev logs when warm-cache runs across many chains).
 *
 * Expected noise:
 *   - Contract revert: lens called against an address that isn't a proper
 *     vault on the target chain. Stale labels entries produce these.
 *   - Network unreachable: DNS failure / fetch failed against the RPC URL.
 *     Usually a bad env var or upstream outage; same handling either way.
 *
 * Everything else (ABI decode errors, unexpected exceptions) still logs at
 * error severity with the full error object so genuine issues remain loud.
 */
export const logConciseFetchError = (context: string, chainId: number, subject: string, err: unknown): void => {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('reverted') || msg.includes('Execution reverted')) {
    logWarn(context, `chain=${chainId} ${subject} reverted (likely not deployed on this chain)`)
    return
  }
  if (msg.includes('HTTP request failed') || msg.includes('fetch failed') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
    logWarn(context, `chain=${chainId} RPC unreachable for ${subject}`)
    return
  }
  logWarn(context, err, { severity: 'error' })
}
