/**
 * Read-only proxy for Fuul incentives (euler + euler-looping).
 *
 * Two upstream /incentives calls collapse into one handler response. Each
 * protocol caches separately so one protocol failing doesn't blank out
 * the other. User-specific /claimable-rewards stays direct from the
 * browser — not exposed through this proxy.
 */
import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { reportStatus } from '~/server/utils/log'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
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

  const [eulerResult, loopingResult] = await Promise.allSettled([
    resolveProtocol(chainId, 'euler'),
    resolveProtocol(chainId, 'euler-looping'),
  ])

  const euler = eulerResult.status === 'fulfilled' ? eulerResult.value : []
  const looping = loopingResult.status === 'fulfilled' ? loopingResult.value : []

  for (const protocol of FUUL_PROTOCOLS) {
    const result = protocol === 'euler' ? eulerResult : loopingResult
    if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
      reportStatus('rewards-fuul', `cold-path:${protocol}:${chainId}`, `failed:${msg}`,
        `${protocol} cold fetch failed chain=${chainId}: ${msg}`)
    }
    else {
      reportStatus('rewards-fuul', `cold-path:${protocol}:${chainId}`, 'ok')
    }
  }

  if (eulerResult.status === 'rejected' && loopingResult.status === 'rejected') {
    throw createError({ statusCode: 502, statusMessage: 'Fuul upstream error' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  return { euler, looping }
})

export { FUUL_PROTOCOLS }
