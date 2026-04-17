/**
 * Pre-populates the in-memory TTL caches for every proxy that serves
 * static/low-churn data (labels, token-list, intrinsic APY, euler-chains).
 *
 * Nitro's node-server preset calls `server.listen()` synchronously right
 * after firing plugins and does NOT await plugin promises, so warming
 * necessarily runs in the background. Caches are typically hot within
 * ~5 s of boot; users arriving before that pay the usual cold-upstream
 * latency for the specific endpoints they hit, same as today. The
 * periodic 4-min re-warm keeps every entry ahead of its 5-min TTL.
 */
import { intrinsicApySources } from '~/entities/custom'
import { toIntrinsicApyRequest } from '~/entities/intrinsic-apy'
import { LABEL_FILES } from '../api/labels/[file].get'
import { getEnabledChainIds } from '../utils/enabled-chains'
import { logWarn } from '../utils/log'

const REWARM_INTERVAL_MS = 4 * 60_000

export default defineNitroPlugin(() => {
  const chainIds = getEnabledChainIds()
  if (chainIds.length === 0) return

  // Dedupe intrinsic-apy requests on their full (path, query) signature so
  // repeated sources collapse to one $fetch per unique request.
  const intrinsicApyRequests = [...new Map(
    intrinsicApySources
      .map(toIntrinsicApyRequest)
      .map(req => [JSON.stringify(req), req] as const),
  ).values()]

  const warmChain = async (chainId: number) => {
    const tasks: Promise<unknown>[] = LABEL_FILES.map(file =>
      $fetch(`/api/labels/${file}`, { query: { chainId } }).catch(() => undefined),
    )
    tasks.push($fetch('/api/token-list', { query: { chainId } }).catch(() => undefined))
    await Promise.allSettled(tasks)
  }

  const warmIntrinsicApy = async () => {
    await Promise.allSettled(
      intrinsicApyRequests.map(req =>
        $fetch(req.path, req.query ? { query: req.query } : {}).catch(() => undefined),
      ),
    )
  }

  const warmEulerChains = () =>
    $fetch('/api/euler-chains').catch(() => undefined)

  const warmAll = async () => {
    try {
      await Promise.allSettled([
        ...chainIds.map(warmChain),
        warmIntrinsicApy(),
        warmEulerChains(),
      ])
    }
    catch (err) {
      logWarn('warm-cache', 'warm-up iteration failed:', err instanceof Error ? err.message : err)
    }
  }

  warmAll()

  const interval = setInterval(warmAll, REWARM_INTERVAL_MS)
  interval.unref()
})
