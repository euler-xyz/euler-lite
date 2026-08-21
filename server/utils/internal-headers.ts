import type { H3Event } from 'h3'
import {
  EDGE_ORIGIN_AUTH_HEADER,
  edgeHonorsInternalSentinel,
  INTERNAL_MARKER_HEADER,
  INTERNAL_SENTINEL_HEADER,
  INTERNAL_SENTINEL_VALUE,
  parseEdgeProvider,
} from '~/utils/edge-presets'
import { timingSafeEqualStrings } from '~/server/utils/timing-safe'

/**
 * Synthetic headers for server-internal $fetch calls.
 *
 * The rate-limit middleware in production (DOPPLER_ENVIRONMENT=prd) fails
 * closed when the configured edge provider supplies no trusted client
 * identity, and the geo-gate middleware fails closed when it supplies no
 * country. Internal fetches from warm-cache, vaults-cache, etc. never
 * traverse the edge, so without these headers every internal request would
 * be 403'd or 451'd. Downstream middleware recognises them via
 * `isInternalRequest` and bypasses those checks; internal traffic is not
 * rate-limited (warm-cache issues at most ~240 requests per 5-min cycle
 * against a >=600/min-per-endpoint budget).
 *
 * Two trust models, selected by whether EDGE_ORIGIN_SECRET is configured:
 *
 * - Secret configured: internal fetches stamp the origin-auth header plus
 *   an internal marker header, both carrying the secret. External clients
 *   cannot forge the marker without knowing the secret, and the edge never
 *   stamps it (it should strip it from inbound traffic as defense-in-depth).
 *   This is the recommended mode for any deployment fronted by an edge.
 *
 * - No secret: fall back to a loopback sentinel in a header the edge
 *   overwrites in transit (see the sentinel constants and their rationale
 *   in utils/edge-presets.ts). The sentinel is only honoured under presets
 *   where that overwrite actually happens or where no edge-derived trust
 *   exists at all (`edgeHonorsInternalSentinel`); the remaining presets
 *   forward client headers untouched and therefore require
 *   EDGE_ORIGIN_SECRET — enforced at boot by edge-guard. SECURITY: even
 *   where honoured, the sentinel relies on the origin not being directly
 *   reachable — an attacker who bypasses the edge can spoof it to skip
 *   rate limiting AND geo-blocking. Configure EDGE_ORIGIN_SECRET to close
 *   that hole. Do not add these headers to anything that forwards user
 *   input into the downstream URL.
 */
export function getInternalFetchHeaders(): Record<string, string> {
  const secret = process.env.EDGE_ORIGIN_SECRET?.trim()
  if (secret) {
    return {
      [EDGE_ORIGIN_AUTH_HEADER]: secret,
      [INTERNAL_MARKER_HEADER]: secret,
    }
  }
  return { [INTERNAL_SENTINEL_HEADER]: INTERNAL_SENTINEL_VALUE }
}

/**
 * True when the incoming request was issued by this server itself via
 * `getInternalFetchHeaders()`. Middleware uses this to bypass geo/rate
 * checks for warm-cache → `/api/*` traffic that never traversed the edge.
 * See the trust model above.
 */
export function isInternalRequest(event: H3Event): boolean {
  const secret = process.env.EDGE_ORIGIN_SECRET?.trim()
  const headers = event.node.req.headers
  if (secret) {
    const marker = headers[INTERNAL_MARKER_HEADER]
    return typeof marker === 'string' && timingSafeEqualStrings(marker, secret)
  }
  // Defense-in-depth backstop: presets that require the secret never honour
  // the sentinel, even if a deployment somehow reaches this state.
  if (!edgeHonorsInternalSentinel(parseEdgeProvider(process.env.EDGE_PROVIDER))) {
    return false
  }
  return headers[INTERNAL_SENTINEL_HEADER] === INTERNAL_SENTINEL_VALUE
}
