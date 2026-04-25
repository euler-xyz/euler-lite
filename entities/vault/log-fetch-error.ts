import { logger } from '~/utils/logger'
import { summarizeViemError } from '~/utils/viem-errors'

/**
 * Concise structured warn for vault/lens fetch failures. Detects the two
 * classes of "expected operational noise" — RPC transport failures (timeout,
 * HTTP 5xx, fetch failed, rate-limited) and on-chain reverts against an
 * address that isn't a valid vault on the target chain — and emits a single
 * structured log line. Walks the cause chain via `summarizeViemError`, so a
 * wrapped TimeoutError reads as `kind: 'rpc-timeout'` and not `unknown`.
 *
 * Anything else is logged at error severity, but always with the summarised
 * error shape so we never leak viem's `abi`, `metaMessages` (which carry the
 * raw hex request body of failed `eth_call`s), or `args` payloads.
 */
export const logConciseFetchError = (
  ctx: string,
  chainId: number,
  subject: string,
  err: unknown,
): void => {
  const summary = summarizeViemError(err)

  if (summary.kind === 'contract-revert') {
    logger.warn(
      { ctx, chainId, subject, kind: summary.kind },
      `${subject} reverted (likely not deployed on this chain)`,
    )
    return
  }

  if (summary.isTransport) {
    logger.warn(
      { ctx, chainId, subject, kind: summary.kind, ...(summary.url != null ? { url: summary.url } : {}) },
      `RPC ${summary.kind.replace('rpc-', '')} for ${subject}`,
    )
    return
  }

  logger.error({ ctx, chainId, subject, err }, `unexpected fetch error for ${subject}`)
}
