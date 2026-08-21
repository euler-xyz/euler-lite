/**
 * Edge-provider presets: the single place where vendor-specific request
 * headers are known. Everything downstream (middleware, routes, services)
 * consumes the normalized `EdgeInputs` shape via `getEdgeContext()` in
 * `server/utils/edge.ts` and must stay vendor-neutral.
 *
 * The preset is selected with the `EDGE_PROVIDER` env var. The default is
 * `none`: no edge-derived trust, which keeps forks and preview deployments
 * working with zero configuration. Production deployments must pick a
 * preset explicitly (enforced at boot by `server/plugins/edge-guard.ts`).
 *
 * This module is intentionally pure (no node/h3 imports) so the client
 * bundle can consult preset capabilities (see `composables/useEnvConfig.ts`).
 */

export const EDGE_PROVIDERS = ['cloudflare', 'google', 'cloudfront', 'none'] as const

export type EdgeProvider = (typeof EDGE_PROVIDERS)[number]

/**
 * Origin-auth header: when `EDGE_ORIGIN_SECRET` is configured, the edge
 * must stamp this header with the secret on every request it forwards to
 * the origin. Requests without it are treated as having bypassed the edge.
 */
export const EDGE_ORIGIN_AUTH_HEADER = 'x-edge-origin-auth'

/**
 * Internal-fetch marker header: set (with the origin-auth secret as value)
 * only by server-internal $fetch calls, never by the edge. Because the
 * value is the secret itself, external clients cannot forge it. The edge
 * should additionally strip this header from inbound traffic as
 * defense-in-depth.
 */
export const INTERNAL_MARKER_HEADER = 'x-edge-internal'

/**
 * No-secret internal sentinel. Deliberately reuses the cloudflare preset's
 * trusted-IP header: that edge always overwrites it in transit, so external
 * clients cannot smuggle the loopback value through the edge. See
 * `server/utils/internal-headers.ts` for the full trust model.
 */
export const INTERNAL_SENTINEL_HEADER = 'cf-connecting-ip'
export const INTERNAL_SENTINEL_VALUE = '127.0.0.1'

type RawHeaders = Record<string, string | string[] | undefined>

/** Normalized trust inputs every preset reduces to. `null` = unmeasured. */
export interface EdgeInputs {
  clientIp: string | null
  country: string | null
  vpnIsUsed: boolean | null
}

export function parseEdgeProvider(raw: string | undefined): EdgeProvider {
  const value = raw?.trim().toLowerCase()
  if (!value) return 'none'
  if ((EDGE_PROVIDERS as readonly string[]).includes(value)) return value as EdgeProvider
  // Fail loudly on typos: silently falling back to `none` would disable
  // geo-blocking on a deployment that intended to have it.
  throw new Error(`Unknown EDGE_PROVIDER "${raw}" — expected one of: ${EDGE_PROVIDERS.join(', ')}`)
}

/** Whether the preset is expected to deliver a country for every request. */
export function edgeProvidesGeo(provider: EdgeProvider): boolean {
  return provider !== 'none'
}

/** Whether the preset delivers VPN/proxy evidence headers. */
export function edgeProvidesVpnEvidence(provider: EdgeProvider): boolean {
  return provider === 'cloudflare'
}

/**
 * Uppercase ISO 3166-1 alpha-2 or null. 'XX' (unknown IP) and non-alpha
 * codes (e.g. 'T1' for Tor exit nodes) are treated as undetermined.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const country = raw?.toUpperCase()
  return (country && /^[A-Z]{2}$/.test(country) && country !== 'XX') ? country : null
}

function singleHeader(headers: RawHeaders, name: string): string | null {
  const value = headers[name]
  // Arrays (duplicate headers) are treated as absent: a trusted edge sets
  // each of these headers exactly once.
  return (typeof value === 'string' && value.trim()) ? value.trim() : null
}

function forwardedForEntries(headers: RawHeaders): string[] {
  const raw = headers['x-forwarded-for']
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  return joined.split(',').map(entry => entry.trim()).filter(Boolean)
}

function isTruthyHeader(value: string | string[] | undefined): boolean {
  const headers = Array.isArray(value) ? value : [value]
  return headers
    .filter((header): header is string => typeof header === 'string')
    .flatMap(header => header.split(','))
    .some(token => token.trim().toLowerCase() === 'true')
}

function hasHeader(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined
}

// The VPN verdict comes from edge-set request headers, never from the client
// body — a client could otherwise clear its own flag. When neither header is
// present the measurement is unknown and reported as null (stored upstream
// as "not measured"), never as a fabricated false.
function deriveVpnEvidence(headers: RawHeaders): boolean | null {
  const vpn = headers['x-is-vpn']
  const proxyOrVpn = headers['x-is-proxy-or-vpn']
  if (!hasHeader(vpn) && !hasHeader(proxyOrVpn)) {
    return null
  }
  return isTruthyHeader(vpn) || isTruthyHeader(proxyOrVpn)
}

// cloudfront-viewer-address is always "<ip>:<port>", IPv6 included
// (e.g. "2001:db8::1:41768"), so stripping after the last colon is safe.
function stripPort(address: string): string {
  const separator = address.lastIndexOf(':')
  return separator === -1 ? address : address.slice(0, separator)
}

export function extractEdgeInputs(
  provider: EdgeProvider,
  headers: RawHeaders,
  socketAddress: string | undefined,
): EdgeInputs {
  switch (provider) {
    case 'cloudflare':
      return {
        clientIp: singleHeader(headers, 'cf-connecting-ip'),
        country: normalizeCountry(singleHeader(headers, 'cf-ipcountry')),
        vpnIsUsed: deriveVpnEvidence(headers),
      }
    case 'google': {
      // Google external LBs append "<client-ip>, <lb-ip>" to x-forwarded-for,
      // so with exactly one LB hop the client is the second-to-last entry.
      // Fewer than two entries means the request cannot have traversed the
      // LB — no trustworthy identity.
      const entries = forwardedForEntries(headers)
      return {
        clientIp: entries.length >= 2 ? entries[entries.length - 2] : null,
        country: normalizeCountry(singleHeader(headers, 'x-client-geo')),
        vpnIsUsed: null,
      }
    }
    case 'cloudfront': {
      const viewer = singleHeader(headers, 'cloudfront-viewer-address')
      return {
        clientIp: viewer ? stripPort(viewer) : null,
        country: normalizeCountry(singleHeader(headers, 'cloudfront-viewer-country')),
        vpnIsUsed: null,
      }
    }
    case 'none': {
      // Without an edge the only semi-trustworthy identity is the rightmost
      // x-forwarded-for entry (appended by the hosting platform, unlike the
      // client-controlled leftmost entries), falling back to the socket peer.
      const entries = forwardedForEntries(headers)
      return {
        clientIp: entries[entries.length - 1] ?? socketAddress?.trim() ?? null,
        country: null,
        vpnIsUsed: null,
      }
    }
  }
}
