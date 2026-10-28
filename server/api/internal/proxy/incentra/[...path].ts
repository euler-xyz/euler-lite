/**
 * Server-side proxy for the Incentra (Brevis) rewards API.
 *
 * SDK config slots:
 *   - rewardsBrevisApiUrl       → defaults to /sdk/v1/eulerCampaigns (POST)
 *   - rewardsBrevisProofsApiUrl → defaults to /v1/getMerkleProofsBatch (POST)
 *
 * Point both at this proxy (`/api/internal/proxy/incentra/sdk/v1/eulerCampaigns`,
 * `/api/internal/proxy/incentra/v1/getMerkleProofsBatch`). The upstream base
 * comes from `INCENTRA_API_URL` (default `https://incentra-prd.brevis.network`)
 * and the request body is forwarded verbatim. Responses are TTL-cached by
 * (method + target + body hash) for cross-tab sharing.
 */
import { createProviderProxy, upstreamFromEnv } from '~/server/utils/provider-proxy'
import { isAllowedIncentraProxyRequest } from '~/server/utils/rewards-proxy-allowlist'

export default defineEventHandler(createProviderProxy({
  name: 'Incentra',
  ctx: 'incentra-proxy',
  prefix: '/api/internal/proxy/incentra/',
  upstream: upstreamFromEnv(['INCENTRA_API_URL', 'NUXT_PUBLIC_INCENTRA_API_URL'], 'https://incentra-prd.brevis.network'),
  methods: ['POST'],
  allow: isAllowedIncentraProxyRequest,
  forwardBody: true,
  rateLimit: { max: 600, windowMs: 60_000 },
  cache: { ttlMs: 60_000, browser: 'public, max-age=30, stale-while-revalidate=30' },
}))
