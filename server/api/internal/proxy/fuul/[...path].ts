/**
 * Server-side proxy for Fuul's rewards API.
 *
 * The SDK's rewardsDirectAdapter constructs URLs like
 *   `${fuulApiUrl}/incentives?protocol=euler&chain_id=1`
 *   `${fuulApiUrl}/claimable-rewards?protocol=euler&user_address=0x…&chain_id=1`
 *
 * Point the SDK at `/api/internal/proxy/fuul` and this handler rewrites to the
 * real upstream (`FUUL_API_URL`, default `https://api.fuul.xyz/api/v1`).
 * Fuul is anonymous, so the upstream may be overridden from env.
 */
import { createProviderProxy, upstreamFromEnv } from '~/server/utils/provider-proxy'
import { isAllowedFuulProxyRequest } from '~/server/utils/rewards-proxy-allowlist'

export default defineEventHandler(createProviderProxy({
  name: 'Fuul',
  ctx: 'fuul-proxy',
  prefix: '/api/internal/proxy/fuul/',
  upstream: upstreamFromEnv(['FUUL_API_URL', 'NUXT_PUBLIC_FUUL_API_URL'], 'https://api.fuul.xyz/api/v1'),
  methods: ['GET', 'HEAD'],
  allow: isAllowedFuulProxyRequest,
  rateLimit: { max: 600, windowMs: 60_000 },
  cache: { ttlMs: 60_000, browser: 'public, max-age=30, stale-while-revalidate=30' },
}))
