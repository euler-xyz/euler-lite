/**
 * Server-side proxy for Turtle stream reward proofs.
 *
 * Lite calls:
 *   `/api/internal/proxy/turtle/streams/merkle_proofs?wallet=0x…&streamIds=…`
 *
 * Forwards to Turtle Earn (a fixed upstream — see `turtle-proxy.ts`) while
 * keeping the browser same-origin and allowlisting only the reward proof
 * endpoint needed for claim planning.
 *
 * Turtle requires an API key on every request. The server-only
 * `TURTLE_EARN_API_KEY` is attached as `X-API-Key` here and nowhere else:
 * caller headers are never forwarded, the key is never logged, and when it is
 * missing the route answers 503 without contacting upstream. Redirects are
 * not followed so the key cannot be replayed against another host, and the
 * server TTL cache is bypassed because proofs are per wallet.
 */
import { createProviderProxy } from '~/server/utils/provider-proxy'
import { isAllowedTurtleProxyRequest } from '~/server/utils/rewards-proxy-allowlist'
import { TURTLE_EARN_API_URL, buildTurtleProxyRequestHeaders } from '~/server/utils/turtle-proxy'

export default defineEventHandler(createProviderProxy({
  name: 'Turtle',
  ctx: 'turtle-proxy',
  prefix: '/api/internal/proxy/turtle/',
  upstream: TURTLE_EARN_API_URL,
  methods: ['GET', 'HEAD'],
  allow: isAllowedTurtleProxyRequest,
  headers: buildTurtleProxyRequestHeaders,
  redirect: 'manual',
  rateLimit: { max: 300, windowMs: 60_000 },
  cache: { ttlMs: 0, bypass: true, browser: 'no-store' },
}))
