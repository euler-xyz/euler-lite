/**
 * Server-side proxy for Merkl v4 opportunity / user-reward endpoints.
 *
 * The SDK's rewardsDirectAdapter fetches `${merklApiUrl}/opportunities?...`
 * directly from the browser. api.merkl.xyz doesn't set permissive CORS
 * headers, so direct fetches from the lite origin fail with `ERR_FAILED`.
 * Point the SDK at `/api/internal/proxy/merkl` instead.
 *
 * Merkl is reachable anonymously (10 req/sec), but that quota is shared across
 * all users because every request egresses from this one origin. Set the
 * server-only `MERKL_API_KEY` env var to send `X-API-Key` upstream for a higher
 * quota — see `buildMerklProxyRequestHeaders` in `server/utils/merkl-proxy.ts`.
 */
import { createProviderProxy } from '~/server/utils/provider-proxy'
import { isAllowedMerklProxyRequest } from '~/server/utils/rewards-proxy-allowlist'
import { buildMerklProxyRequestHeaders } from '~/server/utils/merkl-proxy'

const isUserRewardsPath = (path: string): boolean =>
  /^users\/0x[a-fA-F0-9]{40}\/rewards$/.test(path.replace(/\/+$/, ''))

export default defineEventHandler(createProviderProxy({
  name: 'Merkl',
  ctx: 'merkl-proxy',
  prefix: '/api/internal/proxy/merkl/',
  upstream: 'https://api.merkl.xyz/v4',
  methods: ['GET', 'HEAD'],
  allow: isAllowedMerklProxyRequest,
  headers: buildMerklProxyRequestHeaders,
  rateLimit: { max: 600, windowMs: 60_000 },
  // Short cache: the adapter polls on its own cadence; this lets concurrent
  // tabs and users share one upstream response per query.
  cache: { ttlMs: 60_000, browser: 'public, max-age=60' },
  // The SDK omits `type` on user-reward reads; Merkl then returns every
  // reward kind, so default to token rewards.
  rewriteTarget: (target, rest) => {
    if (isUserRewardsPath(rest) && !target.searchParams.has('type')) {
      target.searchParams.set('type', 'TOKEN')
    }
  },
}))
