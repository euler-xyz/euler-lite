/**
 * Synthetic headers for server-internal $fetch calls.
 *
 * The rate-limit middleware in production (DOPPLER_ENVIRONMENT=prd) fails
 * closed when `cf-connecting-ip` is absent — a Cloudflare egress invariant
 * that keeps direct-to-origin traffic out. Internal fetches from warm-cache,
 * vaults-cache, etc. don't go through Cloudflare, so without this header
 * every internal request would silently 403.
 *
 * 127.0.0.1 is a fixed sentinel — all server-internal traffic shares one
 * rate-limit bucket, which is fine: warm-cache issues at most ~240
 * requests per 5-min cycle against a >=600/min-per-endpoint budget.
 *
 * SECURITY: this sentinel relies on origin ingress NOT being directly
 * reachable — Cloudflare is the only public entrypoint. If that
 * assumption changes (eg a new ingress is exposed), attackers could
 * spoof this header to bypass rate limiting. Do not add the header to
 * anything that forwards user input into the downstream URL, and keep
 * origin locked behind Cloudflare.
 */
export const INTERNAL_FETCH_HEADERS = { 'cf-connecting-ip': '127.0.0.1' } as const
