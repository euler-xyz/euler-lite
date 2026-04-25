/**
 * Server-side intrinsic-APY orchestration.
 *
 * Consolidates every upstream fetch and extraction that used to live in
 * `services/intrinsicApy/*` on the client. The client now issues one
 * parameter-less request (`GET /api/intrinsic-apy?chainId=X`) and gets
 * back a flat `{ [lowercaseAddress]: IntrinsicApyInfo }` map — no
 * provider knowledge, no giant upstream payloads on the wire.
 *
 * Caching: each upstream URL is cached for 5 min with in-flight dedup.
 * A warm-cache refetch every 5 min force-refreshes every entry.
 */
import type { IntrinsicApySourceConfig } from '~/entities/custom'
import { intrinsicApySources } from '~/entities/custom'
import { STABLEWATCH_SOURCE_URL } from '~/entities/constants'
import type { IntrinsicApyInfo } from '~/entities/intrinsic-apy'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup, scheduleBackgroundRefresh } from '~/server/utils/in-flight'
import { reportStatus } from '~/server/utils/log'
import { logger } from '~/utils/logger.server'
import { chainTag } from '~/utils/chain-tag'

const CACHE_TTL_MS = 5 * 60 * 1000
const PENDLE_MATURITY_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000

const UPSTREAM_URLS = {
  defillama: 'https://yields.llama.fi/pools',
  etherfi: 'https://ether.fi/api/dapp/protocol/protocol-detail',
  puffer: 'https://api-v2.puffer.fi/backend-for-frontend/tvl/all',
  treehouse: 'https://api.treehouse.finance/apy',
  spark: 'https://info-sky.blockanalitica.com/api/v1/overall/?format=json',
  benqi: 'https://api.benqi.fi/liquidstaking/apr',
  avant: 'https://app.avantprotocol.com/api/savusdApy',
  ondo: 'https://ondo.finance/api/v1/assets',
  renzo: 'https://app.renzoprotocol.com/api/stats',
  midas: 'https://api-prod.midas.app/api/data/apys',
  yo: 'https://api.yo.xyz/api/v1/vault/stats',
  securitize: 'https://public-feed.securitize.io/asset-stats',
  stablewatch: 'https://api.stablewatch.io/api/pools',
  infinifi: 'https://eth-api.infinifi.xyz/api/protocol/data',
} as const

const PENDLE_API_BASE = 'https://api-v2.pendle.finance/core/v2'

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 200 })
const upstreamInFlight = createInFlightDedup<string, unknown>()

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetchWithTimeout(url)
  if (!resp.ok) {
    // Strip query params to avoid leaking API keys (e.g. Stablewatch) into logs
    const safeUrl = url.split('?')[0]
    throw new Error(`${safeUrl} returned ${resp.status}`)
  }
  return resp.json()
}

/**
 * Cached upstream fetch with in-flight dedup and stale-fallback.
 *
 * Order of operations:
 *  1. Fresh cache hit → return immediately.
 *  2. In-flight request for the same key → share that promise.
 *  3. Issue upstream fetch:
 *     a. On success → cache and return.
 *     b. On failure → if a stale entry exists, return it (keeps the
 *        provider's addresses in the response during transient upstream
 *        blips); otherwise rethrow. Without the stale fallback, any
 *        hiccup after TTL expiry would drop an entire provider's APY
 *        entries from the merged map until the next 5-min window.
 *
 * Concurrent callers for the same `key` (warm-cache + real traffic, multiple
 * chains hitting a shared upstream like defillama) collapse onto one
 * network round-trip.
 */
function fetchUpstream<T = unknown>(key: string, url: string): Promise<T> {
  const fresh = cache.get(key)
  if (fresh !== undefined) return Promise.resolve(fresh as T)

  return upstreamInFlight.run(key, () => fetchJson(url)
    .then((data) => {
      cache.set(key, data)
      reportStatus('intrinsic-apy', `upstream:${key}`, 'ok')
      return data
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      const stale = cache.getStale(key)
      if (stale !== undefined) {
        reportStatus('intrinsic-apy', `upstream:${key}`, `failed-stale:${msg}`,
          `upstream ${key} failed (${msg}); serving stale`)
        return stale
      }
      reportStatus('intrinsic-apy', `upstream:${key}`, `failed:${msg}`,
        `upstream ${key} failed (${msg}); no stale entry`)
      throw err
    })) as Promise<T>
}

/**
 * Bounded-concurrency map. Used by extractors that fan out per-source
 * (pendle, securitize) to avoid hammering an upstream with hundreds of
 * parallel requests when the source list grows.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const settled = await Promise.allSettled(batch.map(fn))
    results.push(...settled)
  }
  return results
}

const PENDLE_CONCURRENCY = 10

const normalize = (v?: string) => v?.toLowerCase() || ''

// ── Per-provider extractors ──────────────────────────────────────────────
// Each takes the sources for this chain + this provider and returns
// [address, info] tuples. Upstream data is fetched inside via fetchUpstream,
// which is cached so repeated calls across chains share one round-trip.

type DefiLlamaSource = Extract<IntrinsicApySourceConfig, { provider: 'defillama' }>
type DefiLlamaPool = { pool?: string, project?: string, apy?: number | null, apyMean30d?: number | null }

const formatDefiLlamaProject = (project: string) =>
  project.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

async function extractDefillama(sources: DefiLlamaSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const res = await fetchUpstream<{ data?: DefiLlamaPool[] }>('defillama', UPSTREAM_URLS.defillama)
  const pools = new Map<string, DefiLlamaPool>()
  for (const p of res?.data ?? []) if (p.pool) pools.set(p.pool, p)

  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const s of sources) {
    const pool = pools.get(s.poolId)
    if (!pool) continue
    const apy = s.useSpotApy ? (pool.apy ?? 0) : (pool.apyMean30d ?? 0)
    const provider = pool.project ? `${formatDefiLlamaProject(pool.project)} via DefiLlama` : 'DefiLlama'
    out.push([normalize(s.address), { apy, provider, source: `https://defillama.com/yields/pool/${s.poolId}` }])
  }
  return out
}

type PendleSource = Extract<IntrinsicApySourceConfig, { provider: 'pendle' }>
type PendleMarketData = { impliedApy?: number, timestamp?: string }

const isPendleMatured = (timestamp?: string): boolean => {
  if (!timestamp) return true
  return Date.now() - new Date(timestamp).getTime() > PENDLE_MATURITY_STALE_THRESHOLD_MS
}

async function extractPendle(sources: PendleSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const settled = await mapWithConcurrency(sources, PENDLE_CONCURRENCY, async (s) => {
    const apiChainId = s.crossChainSourceChainId ?? s.chainId
    const key = `pendle:${apiChainId}:${s.pendleMarket.toLowerCase()}`
    const url = `${PENDLE_API_BASE}/${apiChainId}/markets/${s.pendleMarket}/data`
    const data = await fetchUpstream<PendleMarketData>(key, url)
    return { source: s, data }
  })

  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const r of settled) {
    // Per-market failures are already reported by fetchUpstream's
    // reportStatus (keyed by `upstream:pendle:{chainId}:{market}`) — no
    // need to double-log them here.
    if (r.status !== 'fulfilled') continue
    const { source, data } = r.value
    if (!data || isPendleMatured(data.timestamp)) {
      out.push([normalize(source.address), { apy: 0, provider: 'Pendle' }])
      continue
    }
    out.push([normalize(source.address), {
      apy: (data.impliedApy ?? 0) * 100,
      provider: 'Pendle',
      source: 'https://app.pendle.finance/trade/markets',
    }])
  }
  return out
}

type SecuritizeSource = Extract<IntrinsicApySourceConfig, { provider: 'securitize' }>
type SecuritizeAsset = { token_address?: string, nav_yield_30d?: string | number, distribution_yield?: string | number }

async function extractSecuritize(sources: SecuritizeSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const symbols = [...new Set(sources.map(s => s.symbol.toUpperCase()))]
  const settled = await Promise.allSettled(symbols.map(async (symbol) => {
    const key = `securitize:${symbol}`
    const url = `${UPSTREAM_URLS.securitize}?symbol=${encodeURIComponent(symbol)}`
    return await fetchUpstream<{ data?: SecuritizeAsset[] }>(key, url)
  }))

  const entries: SecuritizeAsset[] = []
  for (const r of settled) {
    // Per-symbol failures are reported by fetchUpstream's reportStatus
    // (keyed by `upstream:securitize:{symbol}`) — no need to double-log.
    if (r.status === 'fulfilled' && Array.isArray(r.value?.data)) entries.push(...r.value.data)
  }

  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const s of sources) {
    const match = entries.find(e => normalize(e.token_address) === normalize(s.address))
    if (!match) continue
    const raw = match[s.yieldField]
    const apy = typeof raw === 'string' ? parseFloat(raw) || 0 : (raw ?? 0)
    out.push([normalize(s.address), {
      apy,
      provider: 'Securitize',
      source: `https://public-feed.securitize.io/asset-stats?symbol=${s.symbol}`,
    }])
  }
  return out
}

type StablewatchSource = Extract<IntrinsicApySourceConfig, { provider: 'stablewatch' }>
type StablewatchPool = { metrics?: { apy?: { avg7d?: number | string } }, token?: { chains?: Record<string, string[]> } }
const STABLEWATCH_CHAIN_ID_TO_NAME: Record<number, string> = {
  1: 'ethereum', 56: 'bnbsmartchain', 146: 'sonic', 239: 'tac', 8453: 'base',
  9745: 'plasma', 42161: 'arbitrumone', 43114: 'avalanche', 59144: 'lineamainnet',
}
const normalizeStablewatchChainName = (raw: string): string => {
  const trimmed = raw.toLowerCase().replace(/\s+/g, '')
  if (trimmed === 'binance-smart-chain') return 'bnbsmartchain'
  if (trimmed === 'linea') return 'lineamainnet'
  if (trimmed === 'arbitrum') return 'arbitrumone'
  return trimmed
}

async function extractStablewatch(sources: StablewatchSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const apiKey = process.env.STABLEWATCH_API_KEY
  if (!apiKey) return []

  const url = new URL(UPSTREAM_URLS.stablewatch)
  url.searchParams.set('api_key', apiKey)
  const res = await fetchUpstream<{ data?: StablewatchPool[] }>('stablewatch', url.toString())

  const lookup = new Map<string, number>()
  for (const pool of res?.data ?? []) {
    const apyRaw = pool.metrics?.apy?.avg7d
    const apy = typeof apyRaw === 'number' ? apyRaw : Number(apyRaw)
    if (!Number.isFinite(apy) || !pool.token?.chains) continue
    for (const [rawChainName, addresses] of Object.entries(pool.token.chains)) {
      if (!Array.isArray(addresses)) continue
      const chainName = normalizeStablewatchChainName(rawChainName)
      for (const addr of addresses) {
        if (typeof addr === 'string') lookup.set(`${chainName}:${addr.toLowerCase()}`, Math.max(0, apy))
      }
    }
  }

  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const s of sources) {
    const chainName = STABLEWATCH_CHAIN_ID_TO_NAME[s.chainId]
    if (!chainName) continue
    const apy = lookup.get(`${chainName}:${s.address.toLowerCase()}`)
    if (apy === undefined) continue
    out.push([normalize(s.address), { apy, provider: 'Stablewatch', source: STABLEWATCH_SOURCE_URL }])
  }
  return out
}

type RenzoSource = Extract<IntrinsicApySourceConfig, { provider: 'renzo' }>
type RenzoStats = { data?: { apr?: { data?: { rate?: number }, pzETHAPR?: { rate?: number } } } }

async function extractRenzo(sources: RenzoSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const res = await fetchUpstream<RenzoStats>('renzo', UPSTREAM_URLS.renzo)
  const apr = res?.data?.apr
  return sources.map(s => [normalize(s.address), {
    apy: s.renzoVariant === 'pzETH' ? Number(apr?.pzETHAPR?.rate ?? 0) : Number(apr?.data?.rate ?? 0),
    provider: 'Renzo',
    source: 'https://app.renzoprotocol.com',
  }])
}

type MidasSource = Extract<IntrinsicApySourceConfig, { provider: 'midas' }>

async function extractMidas(sources: MidasSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const data = await fetchUpstream<Record<string, number>>('midas', UPSTREAM_URLS.midas)
  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const s of sources) {
    const rate = data?.[s.midasKey]
    if (rate === undefined) continue
    out.push([normalize(s.address), { apy: Number(rate) * 100, provider: 'Midas', source: 'https://midas.app' }])
  }
  return out
}

type InfinifiSource = Extract<IntrinsicApySourceConfig, { provider: 'infinifi' }>
type InfinifiResponse = {
  data?: {
    stats?: {
      locked?: Record<string, { average7dAPY?: number }>
      staked?: { average7dAPY?: number }
    }
  }
}

async function extractInfinifi(sources: InfinifiSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const res = await fetchUpstream<InfinifiResponse>('infinifi', UPSTREAM_URLS.infinifi)
  const stats = res?.data?.stats
  return sources.map((s) => {
    const raw = s.infinifiVariant === 'staked'
      ? Number(stats?.staked?.average7dAPY ?? 0)
      : Number(s.infinifiLockedKey ? stats?.locked?.[s.infinifiLockedKey]?.average7dAPY ?? 0 : 0)
    return [normalize(s.address), {
      apy: raw * 100,
      provider: 'InfiniFi',
      source: 'https://infinifi.xyz',
    }]
  })
}

type YoSource = Extract<IntrinsicApySourceConfig, { provider: 'yo' }>

async function extractYo(sources: YoSource[]): Promise<Array<[string, IntrinsicApyInfo]>> {
  const res = await fetchUpstream<{ data?: Array<{ contracts?: { vaultAddress?: string }, yield?: { '7d'?: number } }> }>('yo', UPSTREAM_URLS.yo)
  const apyByAddr = new Map<string, number>()
  for (const v of res?.data ?? []) {
    const a = v.contracts?.vaultAddress
    if (a) apyByAddr.set(a.toLowerCase(), v.yield?.['7d'] ?? 0)
  }
  const out: Array<[string, IntrinsicApyInfo]> = []
  for (const s of sources) {
    const apy = apyByAddr.get(normalize(s.address))
    if (apy === undefined) continue
    out.push([normalize(s.address), { apy, provider: 'YO', source: 'https://yo.xyz' }])
  }
  return out
}

/**
 * "Simple" providers share the shape: one static upstream URL, one scalar
 * APY extracted from the response, applied uniformly to every source in
 * the provider's source list.
 */
interface SimpleProviderSpec<T> {
  key: keyof typeof UPSTREAM_URLS
  name: string
  sourceUrl?: string
  extract: (data: T) => number
}

/**
 * Structural shape used only for the `satisfies` constraint on SIMPLE_SPECS
 * below. Each spec entry has its own concrete `T`; the record can't fix a
 * single `T` without breaking variance, so the shape check ignores it.
 * extractSimple re-applies the per-call `T` via its own generic.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous record constraint
type SimpleProviderSpecShape = SimpleProviderSpec<any>

async function extractSimple<S extends IntrinsicApySourceConfig, T>(
  sources: S[],
  spec: SimpleProviderSpec<T>,
): Promise<Array<[string, IntrinsicApyInfo]>> {
  const data = await fetchUpstream<T>(spec.key, UPSTREAM_URLS[spec.key])
  const apy = spec.extract(data)
  if (!Number.isFinite(apy) || apy <= 0) return []
  return sources.map(s => [normalize(s.address), {
    apy,
    provider: spec.name,
    ...(spec.sourceUrl ? { source: spec.sourceUrl } : {}),
  }])
}

// Providers with dedicated extractors in the switch below.
type ExplicitProvider = 'defillama' | 'pendle' | 'securitize' | 'stablewatch' | 'renzo' | 'midas' | 'yo' | 'infinifi'
// Every remaining provider must have an entry in SIMPLE_SPECS — enforced at the type level.
type SimpleProvider = Exclude<IntrinsicApySourceConfig['provider'], ExplicitProvider>

const SIMPLE_SPECS = {
  etherfi: {
    key: 'etherfi',
    name: 'Ether.fi',
    sourceUrl: 'https://app.ether.fi',
    extract: (d: { '7_day_apr'?: number, '7_day_restaking_apr'?: number }) =>
      ((d['7_day_apr'] ?? 0) / 0.9) + (d['7_day_restaking_apr'] ?? 0),
  },
  spark: {
    key: 'spark',
    name: 'Spark',
    sourceUrl: 'https://info-sky.blockanalitica.com',
    extract: (arr: Array<{ sky_savings_rate_apy?: string }>) => Number(arr[0]?.sky_savings_rate_apy ?? 0) * 100,
  },
  puffer: {
    key: 'puffer',
    name: 'Puffer',
    sourceUrl: 'https://www.puffer.fi',
    extract: (d: { apy?: number }) => Number(d.apy ?? 0),
  },
  treehouse: {
    key: 'treehouse',
    name: 'Treehouse',
    sourceUrl: 'https://www.treehouse.finance',
    extract: (d: { total_apr_teth?: number }) => Number(d.total_apr_teth ?? 0),
  },
  ondo: {
    key: 'ondo',
    name: 'Ondo',
    sourceUrl: 'https://ondo.finance',
    extract: (d: { assets?: Array<{ symbol?: string, apy?: number }> }) => {
      const usdy = (d.assets ?? []).find(a => a.symbol?.toLowerCase() === 'usdy')
      return Number(usdy?.apy ?? 0)
    },
  },
  benqi: {
    key: 'benqi',
    name: 'Benqi',
    sourceUrl: 'https://benqi.fi',
    extract: (d: { apr?: number }) => Number(d.apr ?? 0) * 100,
  },
  avant: {
    key: 'avant',
    name: 'Avant',
    sourceUrl: 'https://avantprotocol.com',
    extract: (d: { savusdApy?: number }) => Number(d.savusdApy ?? 0),
  },
} satisfies Record<SimpleProvider, SimpleProviderSpecShape>

async function extractForProvider(
  provider: IntrinsicApySourceConfig['provider'],
  sources: IntrinsicApySourceConfig[],
): Promise<Array<[string, IntrinsicApyInfo]>> {
  switch (provider) {
    case 'defillama': return extractDefillama(sources as DefiLlamaSource[])
    case 'pendle': return extractPendle(sources as PendleSource[])
    case 'securitize': return extractSecuritize(sources as SecuritizeSource[])
    case 'stablewatch': return extractStablewatch(sources as StablewatchSource[])
    case 'renzo': return extractRenzo(sources as RenzoSource[])
    case 'midas': return extractMidas(sources as MidasSource[])
    case 'yo': return extractYo(sources as YoSource[])
    case 'infinifi': return extractInfinifi(sources as InfinifiSource[])
    default: {
      const simpleProvider: SimpleProvider = provider
      const spec = SIMPLE_SPECS[simpleProvider]
      if (!spec) {
        logger.warn({ ctx: 'intrinsic-apy', provider }, 'no extractor for provider')
        return []
      }
      return extractSimple(sources, spec as SimpleProviderSpecShape)
    }
  }
}

/**
 * Handler-level cache of the merged per-chain result. Without this, every
 * /api/intrinsic-apy request re-dispatches to every provider extractor,
 * iterates Pendle markets + DefiLlama pools + Securitize symbols, and
 * re-merges. Upstream fetches are cached, but the orchestration itself is
 * O(sources) per request — noticeable on chains with many Pendle markets.
 */
const mergedCache = createTtlCache<Record<string, IntrinsicApyInfo>>({ ttlMs: CACHE_TTL_MS, maxEntries: 50 })
const mergedInFlight = createInFlightDedup<number, Record<string, IntrinsicApyInfo>>()

const orchestrate = (chainId: number): Promise<Record<string, IntrinsicApyInfo>> =>
  mergedInFlight.run(chainId, async () => {
    const chainSources = intrinsicApySources.filter(s => s.chainId === chainId)
    if (chainSources.length === 0) return {}

    const byProvider = new Map<IntrinsicApySourceConfig['provider'], IntrinsicApySourceConfig[]>()
    for (const s of chainSources) {
      const existing = byProvider.get(s.provider) ?? []
      byProvider.set(s.provider, [...existing, s])
    }

    const providerEntries = [...byProvider.entries()]
    const settled = await Promise.allSettled(
      providerEntries.map(([provider, sources]) => extractForProvider(provider, sources)),
    )

    // `merged` uses a null-prototype bag so nothing we write — even the
    // unlikely `token_address: "__proto__"` from a compromised upstream —
    // can mutate Object.prototype.
    const merged: Record<string, IntrinsicApyInfo> = Object.create(null) as Record<string, IntrinsicApyInfo>
    settled.forEach((r, i) => {
      const [provider] = providerEntries[i]
      if (r.status !== 'fulfilled') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
        reportStatus('intrinsic-apy', `provider:${provider}:chain=${chainId}`, `failed:${msg}`,
          `provider "${provider}" failed for chain ${chainId}: ${msg}`)
        return
      }
      reportStatus('intrinsic-apy', `provider:${provider}:chain=${chainId}`, 'ok')
      for (const [addr, info] of r.value) {
        const existing = merged[addr]
        if (existing) {
          logger.warn(
            {
              ctx: 'intrinsic-apy/merge',
              ...chainTag(chainId),
              address: addr,
              previousProvider: existing.provider,
              previousApy: existing.apy,
              newProvider: info.provider,
              newApy: info.apy,
            },
            'duplicate APY entry overwritten',
          )
        }
        merged[addr] = info
      }
    })
    mergedCache.set(String(chainId), merged)
    return merged
  })

/**
 * Forces a merge orchestration, bypassing the fresh cache. Used by the
 * warm-cache plugin so every cycle actually refreshes the entry instead
 * of cache-hitting a still-fresh value and letting it expire before the
 * next cycle. Reuses any in-flight refresh so concurrent warm cycles
 * don't fan out.
 */
export async function refreshIntrinsicApyForChain(chainId: number): Promise<Record<string, IntrinsicApyInfo>> {
  return mergedInFlight.peek(chainId) ?? orchestrate(chainId)
}

/**
 * Public entry point. Resolves every intrinsic-APY source configured for
 * the given chain and returns a flat map of lowercase-address → APY info.
 *
 * SWR semantics: a fresh entry is returned immediately. A stale entry is
 * served immediately AND kicks off a background refresh — no user ever
 * waits for the ~1s orchestration cost so long as the warm-cache plugin
 * has populated the entry at least once within the staleness ceiling.
 * Only a genuinely-cold chain (never warmed or expired past the ceiling)
 * awaits orchestration.
 */
export async function getIntrinsicApyForChain(chainId: number): Promise<Record<string, IntrinsicApyInfo>> {
  const key = String(chainId)
  const fresh = mergedCache.get(key)
  if (fresh) return fresh

  const stale = mergedCache.getStale(key)
  if (stale) {
    scheduleBackgroundRefresh(`intrinsic-apy chain=${chainId}`,
      () => refreshIntrinsicApyForChain(chainId))
    return stale
  }

  try {
    return await refreshIntrinsicApyForChain(chainId)
  }
  catch (err) {
    const lastStale = mergedCache.getStale(key)
    if (lastStale) {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('intrinsic-apy', `merge-stale-fallback:${chainId}`, `failed:${msg}`,
        `chain ${chainId} merge failed; serving stale: ${msg}`)
      return lastStale
    }
    throw err
  }
}
