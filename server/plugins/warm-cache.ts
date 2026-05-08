/**
 * Pre-populates the in-memory TTL caches for every proxy that serves
 * static/low-churn data (labels, token-list, intrinsic APY, euler-chains).
 *
 * Nitro's node-server preset calls `server.listen()` synchronously right
 * after firing plugins and does NOT await plugin promises, so warming
 * necessarily runs in the background. Caches are typically hot within
 * ~5 s of boot; users arriving before that pay the usual cold-upstream
 * latency for the specific endpoints they hit, same as today. The
 * periodic 5-min re-warm cycles with the TTL so reads against a healthy
 * warm pipeline always find a cached entry (refresh completes just as the
 * previous entry would otherwise expire).
 *
 * Warm-up structure (per cycle):
 *
 *   • Global (parallel with the chain loop): /api/euler-chains and
 *     cross-chain `all/assets.json`.
 *   • Per-chain (serialized one chain at a time): labels, token-list,
 *     intrinsic-apy. Tasks within a single chain still run in parallel.
 *
 * Serializing chains avoids a cold-start thundering herd (~250
 * simultaneous HTTPS requests across all chains × all providers) that
 * overshot the 10 s upstream timeout for slow first-hit DNS/TLS
 * handshakes. Cross-chain upstreams (defillama, stablewatch, etherfi,
 * etc.) dedupe via the in-flight cache, so chains 2..N hit warm cache
 * for those rather than refetching — sequential mode is therefore much
 * cheaper than N× the first chain's wall time.
 *
 * Per-chain warms skip chains listed in `DEPRECATED_CHAINS`. Their data
 * is still served — the first visitor to a deprecated chain pays a
 * cold-upstream fetch, cached from then on under normal TTL behavior.
 *
 * Merkl's /tokens/reward payload is fetched transitively by /api/token-list
 * (one of its sources).
 */
import { LABEL_FILES, refreshLabelFile } from '../api/labels/[file].get'
import { refreshEulerChains } from '../api/euler-chains.get'
import { refreshTokenList } from '../api/token-list.get'
import { getEnabledChainIds } from '~/utils/chain-env'
import { parseDeprecatedChains } from '~/utils/parseDeprecatedChains'
import { reportStatus } from '../utils/log'
import { logger } from '~/server/utils/logger'
import { refreshIntrinsicApyForChain } from '../utils/intrinsic-apy'

const REWARM_INTERVAL_MS = 5 * 60_000

// Nitro dev mode re-imports server plugins across its double-init (Vite
// client build + Nitro server build), which would fire two warm cycles
// back-to-back and schedule two interval timers. Latch on globalThis so
// the second init sees the first's flag and no-ops. No effect in prod
// (plugins run exactly once there).
const WARM_LATCH_KEY = '__eulerLiteWarmCacheStarted'
type WarmLatchedGlobal = typeof globalThis & { [WARM_LATCH_KEY]?: true }

// Wraps a warm task so success and failure flow through transition-based
// logging. A persistently-failing task logs once on first failure, then
// stays silent until it recovers (info) or the error message changes.
// Swallows the rejection so the caller's Promise.allSettled stays clean.
const reportWarm = <T>(context: string, task: Promise<T>): Promise<T | undefined> =>
  task.then(
    (value) => {
      reportStatus('warm-cache', context, 'ok')
      return value
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('warm-cache', context, `failed:${msg}`, `${context} failed: ${msg}`)
      return undefined
    },
  )

// --- Global warms (no dependencies, run once per cycle) ---

// All warms are direct function calls that bypass the handler's
// fresh-cache short-circuit. Without this, warm hits at the 5-min mark
// cache-hit the entry that was set ~1 s into the previous cycle
// (age ≈ 298 s, still fresh), no refresh happens, and the entry then
// expires until the NEXT cycle — leaving ~5 min per cycle where users
// pay the cold-upstream cost. User requests arriving *during* a
// force-refresh continue to see the previous fresh entry via the
// handler's own `cache.get()` short-circuit, so there is no user-facing
// downtime.

const warmEulerChains = () =>
  reportWarm('euler-chains', refreshEulerChains())

// Cross-chain pattern rules for asset geo-blocking live at `all/assets.json`
// upstream. The /api/labels/assets.json handler unions this with the
// per-chain file; warm it once so the first chain-scoped request doesn't
// pay the cold-upstream cost.
const warmGlobalAssets = () =>
  reportWarm('labels/assets.json scope=all', refreshLabelFile('all', 'assets.json'))

// --- Per-chain warms (parallel across chains and within a chain) ---

const warmLabels = (chainId: number): Promise<unknown>[] =>
  LABEL_FILES.map(file =>
    reportWarm(`labels/${file} chain=${chainId}`, refreshLabelFile(chainId, file)),
  )

const warmTokenList = (chainId: number) =>
  reportWarm(`token-list chain=${chainId}`, refreshTokenList(chainId))

const warmIntrinsicApy = (chainId: number) =>
  reportWarm(`intrinsic-apy chain=${chainId}`, refreshIntrinsicApyForChain(chainId))

const warmChainTasks = (chainId: number): Promise<unknown>[] => [
  ...warmLabels(chainId),
  warmTokenList(chainId),
  warmIntrinsicApy(chainId),
]

// --- Orchestration ---

export default defineNitroPlugin(() => {
  const g = globalThis as WarmLatchedGlobal
  if (g[WARM_LATCH_KEY]) return
  g[WARM_LATCH_KEY] = true

  const enabledChainIds = getEnabledChainIds()
  const deprecatedChainIds = new Set(
    parseDeprecatedChains(process.env.DEPRECATED_CHAINS, new Set(enabledChainIds)),
  )
  const chainIds = enabledChainIds.filter(id => !deprecatedChainIds.has(id))
  if (chainIds.length === 0) return

  const warmChainsSequentially = async () => {
    for (const chainId of chainIds) {
      await Promise.allSettled(warmChainTasks(chainId))
    }
  }

  const warmAll = async () => {
    try {
      await Promise.allSettled([
        warmEulerChains(),
        warmGlobalAssets(),
        warmChainsSequentially(),
      ])
    }
    catch (err) {
      logger.warn({ ctx: 'warm-cache', err }, 'warm-up iteration failed')
    }
  }

  warmAll()

  const interval = setInterval(warmAll, REWARM_INTERVAL_MS)
  interval.unref()
})
