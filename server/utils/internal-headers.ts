import type { H3Event } from 'h3'
import { randomBytes } from 'node:crypto'
import {
  EDGE_ORIGIN_AUTH_HEADER,
  INTERNAL_MARKER_HEADER,
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
 * The marker value is either EDGE_ORIGIN_SECRET (when configured) or a
 * random per-process value. Internal $fetch calls are dispatched inside
 * this same process, so the per-process value never needs to be shared —
 * and external clients cannot guess either value, so internal status is
 * not forgeable under any preset. (An earlier design trusted a loopback
 * `cf-connecting-ip` sentinel, which was forgeable wherever the edge did
 * not overwrite that header — notably under the `none` preset.)
 *
 * The edge never stamps the marker header; configure it to strip
 * client-supplied values as defense-in-depth. Do not add these headers to
 * anything that forwards user input into the downstream URL.
 */
const PROCESS_INTERNAL_MARKER = randomBytes(32).toString('base64url')

function internalMarkerValue(): string {
  return process.env.EDGE_ORIGIN_SECRET?.trim() || PROCESS_INTERNAL_MARKER
}

export function getInternalFetchHeaders(): Record<string, string> {
  const secret = process.env.EDGE_ORIGIN_SECRET?.trim()
  if (secret) {
    return {
      [EDGE_ORIGIN_AUTH_HEADER]: secret,
      [INTERNAL_MARKER_HEADER]: secret,
    }
  }
  return { [INTERNAL_MARKER_HEADER]: PROCESS_INTERNAL_MARKER }
}

/**
 * True when the incoming request was issued by this server itself via
 * `getInternalFetchHeaders()`. Middleware uses this to bypass geo/rate
 * checks for warm-cache → `/api/*` traffic that never traversed the edge.
 * See the trust model above.
 */
export function isInternalRequest(event: H3Event): boolean {
  const marker = event.node.req.headers[INTERNAL_MARKER_HEADER]
  return typeof marker === 'string' && timingSafeEqualStrings(marker, internalMarkerValue())
}
