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
import { LABEL_FILES } from '../api/labels/[file].get'
import { getEnabledChainIds } from '~/utils/chain-env'
import { logWarn } from '../utils/log'

const REWARM_INTERVAL_MS = 4 * 60_000

// Synthetic client-IP header for every internal $fetch the warm-cache issues.
// The rate-limit middleware fails-closed when `cf-connecting-ip` is absent in
// production (see server/utils/rate-limit.ts) — without this header every warm
// request would get a silent 403 and the caches would never populate.
// A fixed sentinel IP is fine: warm-cache runs at most ~240 requests/cycle
// against a 1000/min label budget, so sharing one bucket is well-bounded.
const WARM_HEADERS = { 'cf-connecting-ip': '127.0.0.1' } as const

// Nitro dev mode re-imports server plugins across its double-init (Vite
// client build + Nitro server build), which would fire two warm cycles
// back-to-back and schedule two interval timers. Latch on globalThis so
// the second init sees the first's flag and no-ops. No effect in prod
// (plugins run exactly once there).
const WARM_LATCH_KEY = '__eulerLiteWarmCacheStarted'
type WarmLatchedGlobal = typeof globalThis & { [WARM_LATCH_KEY]?: true }

export default defineNitroPlugin(() => {
  const g = globalThis as WarmLatchedGlobal
  if (g[WARM_LATCH_KEY]) return
  g[WARM_LATCH_KEY] = true

  const chainIds = getEnabledChainIds()
  if (chainIds.length === 0) return

  const warmChain = async (chainId: number) => {
    const tasks: Promise<unknown>[] = LABEL_FILES.map(file =>
      $fetch(`/api/labels/${file}`, { query: { chainId }, headers: WARM_HEADERS }).catch(() => undefined),
    )
    tasks.push($fetch('/api/token-list', { query: { chainId }, headers: WARM_HEADERS }).catch(() => undefined))
    tasks.push($fetch('/api/intrinsic-apy', { query: { chainId }, headers: WARM_HEADERS }).catch(() => undefined))
    await Promise.allSettled(tasks)

    // Phase 2: warm vault-factories using earn-vault addresses (labels are cached from above)
    try {
      const earnData = await $fetch<Array<string | { address: string }>>('/api/labels/earn-vaults.json', {
        query: { chainId },
        headers: WARM_HEADERS,
      })
      const addresses = (earnData ?? [])
        .map(e => typeof e === 'string' ? e : e?.address)
        .filter((a): a is string => !!a)
      if (addresses.length > 0) {
        await $fetch('/api/vault-factories', {
          method: 'POST',
          body: { chainId, addresses },
          headers: WARM_HEADERS,
        })
      }
    }
    catch {
      // earn-vaults or vault-factories fetch failed; non-critical
    }
  }

  const warmEulerChains = () =>
    $fetch('/api/euler-chains', { headers: WARM_HEADERS }).catch(() => undefined)

  const warmAll = async () => {
    try {
      await Promise.allSettled([
        ...chainIds.map(warmChain),
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
