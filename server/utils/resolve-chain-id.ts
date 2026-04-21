import { createError, getQuery } from 'h3'
import type { H3Event } from 'h3'
import { getEnabledChainIds } from '~/utils/chain-env'

/**
 * Parses and validates `?chainId=X` from a request. Throws a 400 if the
 * value is missing, non-integer, or zero/negative. When `requireEnabled`
 * (the default) is true, also rejects chains that aren't in the current
 * deployment's enabled set — use `false` for endpoints where a
 * theoretically-supported-but-not-enabled chain is still a valid lookup
 * (e.g. static labels proxies).
 */
export const resolveChainId = (event: H3Event, options: { requireEnabled?: boolean } = {}): number => {
  const { requireEnabled = true } = options
  const chainId = Number(getQuery(event).chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (requireEnabled && !getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }
  return chainId
}
