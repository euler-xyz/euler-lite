/**
 * Pre-populates the in-memory TTL caches for every proxy that serves
 * static/low-churn data (labels, token-list, euler-chains) and for the
 * per-chain vault snapshot served at /api/internal/vaults.
 *
 * Nitro's node-server preset calls `server.listen()` synchronously right
 * after firing plugins and does NOT await plugin promises, so warming
 * necessarily runs in the background. Caches are typically hot within
 * ~5 s of boot; users arriving before that pay the usual cold-upstream
 * latency for the specific endpoints they hit. The periodic re-warm
 * cycles align with the TTLs so reads against a healthy warm pipeline
 * always find a cached entry (refresh completes just as the previous
 * entry would otherwise expire).
 *
 * Two timers, each with its own cadence:
 *
 *   • Global cycle (5 min): /api/internal/euler-chains once, cross-chain
 *     `all/assets.json` once, then per-chain labels + token-list,
 *     serialized across chains.
 *   • Vaults cycle (1 min when V3 is configured, otherwise 5 min):
 *     /api/internal/vaults per chain, serialized.
 *
 * Serializing chains avoids a cold-start thundering herd (~250
 * simultaneous HTTPS requests across all chains × all providers) that
 * overshot the 10 s upstream timeout for slow first-hit DNS/TLS
 * handshakes. Cross-chain upstreams (defillama, V3 prices, etc.) dedupe
 * via the in-flight cache, so chains 2..N hit warm cache for those
 * rather than refetching — sequential mode is therefore much cheaper
 * than N× the first chain's wall time.
 *
 * Per-chain warms skip chains listed in `DEPRECATED_CHAINS`. Their data
 * is still served — the first visitor to a deprecated chain pays a
 * cold-upstream fetch, cached from then on under normal TTL behavior.
 *
 * Merkl's /tokens/reward payload is fetched transitively by /api/internal/token-list
 * (one of its sources).
 */
import { LABEL_FILES, refreshLabelFile } from '../api/internal/labels/[file].get'
import { refreshEulerChains } from '../api/internal/euler-chains.get'
import { refreshTokenList } from '../api/internal/token-list.get'
import { refreshChainVaults } from '../utils/vaults-cache'
import {
  readDisableServerVaultCache,
  readV3ApiUrl,
  warnIfVaultSourceNeedsV3,
} from '~/utils/api-url-env'
import { getEnabledChainIds } from '~/utils/chain-env'
import { parseDeprecatedChains } from '~/utils/parseDeprecatedChains'
import { reportStatus } from '../utils/log'
import { logger } from '~/server/utils/logger'

const REWARM_INTERVAL_MS = 5 * 60_000

// Vaults snapshot gets a separate, faster timer when V3 is configured —
// V3-backed refreshes are cheap (one batched POST per chain hitting V3's
// own cache), so a 1-min rewarm keeps the snapshot tight without
// hammering upstream. Without V3 the snapshot is built from heavier
// onchain lens multicalls, so it rides the global 5-min interval.
const VAULTS_REWARM_INTERVAL_MS = readV3ApiUrl() ? 60_000 : REWARM_INTERVAL_MS

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
// upstream. The /api/internal/labels/assets.json handler unions this with the
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

// Per-chain consolidated vault snapshot served at /api/internal/vaults?chainId=N.
// Warmed so the first user navigation to /lend hydrates instantly from
// cache instead of paying the full lens-multicall + intrinsic-APY fan-out.
const warmVaults = (chainId: number) =>
  reportWarm(`vaults chain=${chainId}`, refreshChainVaults(chainId))

// Labels + token-list — refresh at the global 5-min interval. Vaults run
// on their own faster timer (see `warmVaultsForChains` below).
const warmChainTasks = (chainId: number): Promise<unknown>[] => [
  ...warmLabels(chainId),
  warmTokenList(chainId),
]

// --- Orchestration ---

export default defineNitroPlugin(() => {
  const g = globalThis as WarmLatchedGlobal
  if (g[WARM_LATCH_KEY]) return
  g[WARM_LATCH_KEY] = true

  // One-time boot check: surface a misconfiguration (source needs V3 but
  // no V3_API_URL set) before the first warm cycle starts producing noisy
  // SDK errors. Caller-friendly: a single log line instead of one per
  // failing SDK fetchVaults call.
  warnIfVaultSourceNeedsV3()

  const enabledChainIds = getEnabledChainIds()
  const deprecatedChainIds = new Set(
    parseDeprecatedChains(process.env.DEPRECATED_CHAINS, new Set(enabledChainIds)),
  )
  const chainIds = enabledChainIds.filter(id => !deprecatedChainIds.has(id))
  if (chainIds.length === 0) return

  const serverVaultCacheDisabled = readDisableServerVaultCache()

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

  const warmVaultsForChains = async () => {
    try {
      // Sequential across chains: cross-chain upstreams (V3 prices,
      // intrinsic APY) dedupe via their in-flight maps, so chains 2..N
      // hit warm upstream caches rather than refetching.
      for (const chainId of chainIds) {
        await warmVaults(chainId)
      }
    }
    catch (err) {
      logger.warn({ ctx: 'warm-cache', err }, 'vaults warm cycle failed')
    }
  }

  warmAll()

  const globalInterval = setInterval(warmAll, REWARM_INTERVAL_MS)
  globalInterval.unref()

  // Vault snapshot cycle is opt-out via DISABLE_SERVER_VAULT_CACHE. When
  // disabled, /api/internal/vaults responds 503 and the browser falls through to
  // its normal RPC pipeline — useful when the host can't afford the
  // outbound V3/RPC fan-out the snapshot builder needs, or when running
  // behind aggressive bot-management (CF) that throttles bursty
  // origin-side traffic.
  if (!serverVaultCacheDisabled) {
    warmVaultsForChains()
    // Run the vaults timer separately so its cadence can be faster than
    // the global cycle when V3 is configured. When the two intervals are
    // equal (no V3), the timers naturally double-warm at every cycle; the
    // in-flight dedup inside refreshChainVaults collapses the concurrent
    // calls onto a single upstream pass.
    const vaultsInterval = setInterval(warmVaultsForChains, VAULTS_REWARM_INTERVAL_MS)
    vaultsInterval.unref()
  }
  else {
    logger.info({ ctx: 'warm-cache' }, 'vault snapshot cycle disabled via DISABLE_SERVER_VAULT_CACHE')
  }
})
