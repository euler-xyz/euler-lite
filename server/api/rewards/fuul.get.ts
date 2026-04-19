/**
 * Read-only proxy for Fuul incentives (euler + euler-looping).
 *
 * Two upstream /incentives calls collapse into one handler response. Each
 * protocol caches separately so one protocol failing doesn't blank out
 * the other. User-specific /claimable-rewards stays direct from the
 * browser — not exposed through this proxy.
 */
import { createError, getQuery, setResponseHeader } from 'h3'
import type { H3Event } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { getEnabledChainIds } from '~/utils/chain-env'
import {
  type FuulProtocol,
  readFuul,
  refreshFuulProtocol,
  scheduleRevalidation,
} from '~/server/utils/rewards-cache'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'rewards-fuul-proxy',
})

const FUUL_PROTOCOLS: FuulProtocol[] = ['euler', 'euler-looping']

const resolveChainId = (event: H3Event): number => {
  const raw = getQuery(event).chainId
  const chainId = Number(raw)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }
  return chainId
}

const resolveProtocol = async (chainId: number, protocol: FuulProtocol): Promise<unknown> => {
  const cached = readFuul(chainId, protocol)
  if (cached && !cached.isStale) return cached.data
  if (cached && cached.isStale) {
    scheduleRevalidation(`fuul/${protocol} chain=${chainId}`, () => refreshFuulProtocol(chainId, protocol))
    return cached.data
  }
  return refreshFuulProtocol(chainId, protocol)
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)

  try {
    const [euler, looping] = await Promise.all([
      resolveProtocol(chainId, 'euler'),
      resolveProtocol(chainId, 'euler-looping'),
    ])

    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
    return { euler, looping }
  }
  catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) {
      throw err
    }
    logWarn('rewards-fuul', `cold fetch failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Fuul upstream error' })
  }
})

export { FUUL_PROTOCOLS }
