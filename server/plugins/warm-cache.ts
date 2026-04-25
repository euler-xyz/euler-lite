/**
 * Pre-populates the in-memory TTL caches for every proxy that serves
 * static/low-churn data (labels, token-list, intrinsic APY, euler-chains,
 * vaults snapshot, public reward campaigns).
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
 * Warm-up structure (per cycle): all tasks run in parallel.
 *
 *   • Global:    /api/euler-chains
 *   • Per-chain: labels, token-list, intrinsic-apy, vault-categories,
 *                Merkl opportunities × 3, Brevis campaigns, Fuul × 2,
 *                refreshChainVaults(chainId)
 *
 * Per-chain warms skip chains listed in `DEPRECATED_CHAINS`. Their data
 * is still served — the first visitor to a deprecated chain pays a
 * cold-upstream fetch, cached from then on under normal TTL behavior.
 *
 * `refreshChainVaults` internally $fetches /api/euler-chains and
 * /api/labels/*, and calls `getVaultCategories(chainId)` — those all
 * collapse onto the parallel warms via in-flight dedup at the cache layer,
 * so no duplicate upstream traffic.
 *
 * Merkl's /tokens/reward payload is fetched transitively by /api/token-list
 * (one of its sources). Merkl's ERC20LOGPROCESSOR refresh also calls
 * `getVaultCategories(chainId)` to filter by the chain earn set.
 */
import { LABEL_FILES, refreshLabelFile } from '../api/labels/[file].get'
import { refreshEulerChains } from '../api/euler-chains.get'
import { refreshTokenList } from '../api/token-list.get'
import { getEnabledChainIds } from '~/utils/chain-env'
import { parseDeprecatedChains } from '~/utils/parseDeprecatedChains'
import { reportStatus } from '../utils/log'
import { logger } from '~/server/utils/logger'
import { refreshChainVaults } from '../utils/vaults-cache'
import { refreshVaultCategories } from '../utils/vault-categories-store'
import { refreshIntrinsicApyForChain } from '../utils/intrinsic-apy'
import {
  type FuulProtocol,
  type MerklOpportunityType,
  refreshBrevisCampaigns,
  refreshFuulProtocol,
  refreshMerklType,
} from '../utils/rewards-cache'

const REWARM_INTERVAL_MS = 5 * 60_000

const MERKL_TYPES: MerklOpportunityType[] = ['EULER', 'MULTILENDBORROW', 'ERC20LOGPROCESSOR']
const FUUL_PROTOCOLS: FuulProtocol[] = ['euler', 'euler-looping']

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

// --- Per-chain warms (parallel across chains and within a chain) ---

const warmLabels = (chainId: number): Promise<unknown>[] =>
  LABEL_FILES.map(file =>
    reportWarm(`labels/${file} chain=${chainId}`, refreshLabelFile(chainId, file)),
  )

const warmTokenList = (chainId: number) =>
  reportWarm(`token-list chain=${chainId}`, refreshTokenList(chainId))

const warmIntrinsicApy = (chainId: number) =>
  reportWarm(`intrinsic-apy chain=${chainId}`, refreshIntrinsicApyForChain(chainId))

const warmRewardCampaigns = (chainId: number): Promise<unknown>[] => [
  ...MERKL_TYPES.map(type =>
    reportWarm(`merkl/${type} chain=${chainId}`, refreshMerklType(chainId, type)),
  ),
  reportWarm(`brevis chain=${chainId}`, refreshBrevisCampaigns(chainId)),
  ...FUUL_PROTOCOLS.map(protocol =>
    reportWarm(`fuul/${protocol} chain=${chainId}`, refreshFuulProtocol(chainId, protocol)),
  ),
]

const warmVaultCategories = (chainId: number) =>
  reportWarm(`vault-categories chain=${chainId}`, refreshVaultCategories(chainId))

// Direct call (no $fetch HTTP round-trip) so we get typed errors. Its internal
// $fetches to /api/euler-chains + /api/labels/* collapse onto Stage A's
// parallel warms via in-flight dedup at the cache layer, and its call to
// getVaultCategories() joins the warmVaultCategories task above.
const warmChainVaults = (chainId: number) =>
  reportWarm(`vaults chain=${chainId}`, refreshChainVaults(chainId))

const warmChainTasks = (chainId: number): Promise<unknown>[] => [
  ...warmLabels(chainId),
  warmTokenList(chainId),
  warmIntrinsicApy(chainId),
  warmVaultCategories(chainId),
  ...warmRewardCampaigns(chainId),
  warmChainVaults(chainId),
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

  const warmAll = async () => {
    try {
      await Promise.allSettled([
        warmEulerChains(),
        ...chainIds.flatMap(warmChainTasks),
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
