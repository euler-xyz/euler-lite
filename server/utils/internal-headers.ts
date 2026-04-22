import type { H3Event } from 'h3'

/**
 * Synthetic headers for server-internal $fetch calls.
 *
 * The rate-limit middleware in production (DOPPLER_ENVIRONMENT=prd) fails
 * closed when `cf-connecting-ip` is absent — a Cloudflare egress invariant
 * that keeps direct-to-origin traffic out. The geo-gate middleware
 * likewise fails closed when `cf-ipcountry` is absent. Internal fetches
 * from warm-cache, vaults-cache, etc. don't go through Cloudflare, so
 * without these headers every internal request would be 403'd or 451'd.
 *
 * `cf-connecting-ip` is a fixed loopback sentinel that downstream
 * middleware also uses to identify internal traffic (see isInternalRequest
 * below) — all server-internal traffic shares one rate-limit bucket, which
 * is fine: warm-cache issues at most ~240 requests per 5-min cycle
 * against a >=600/min-per-endpoint budget.
 *
 * SECURITY: this sentinel relies on origin ingress NOT being directly
 * reachable — Cloudflare is the only public entrypoint. If that
 * assumption changes (eg a new ingress is exposed), attackers could
 * spoof these headers to bypass rate limiting AND geo-blocking. Do not
 * add the headers to anything that forwards user input into the
 * downstream URL, and keep origin locked behind Cloudflare.
 */
export const INTERNAL_FETCH_HEADERS = { 'cf-connecting-ip': '127.0.0.1' } as const

/**
 * True when the incoming request bears the loopback `cf-connecting-ip`
 * sentinel set by `INTERNAL_FETCH_HEADERS`. Middleware uses this to
 * bypass geo/rate checks for warm-cache → `/api/*` traffic that never
 * traversed Cloudflare. Relies on the same origin-locked-behind-CF
 * security invariant noted above.
 */
export const isInternalRequest = (event: H3Event): boolean =>
  event.node.req.headers['cf-connecting-ip'] === '127.0.0.1'
