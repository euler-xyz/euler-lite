import type { H3Event } from 'h3'
import { fetchWithTimeout, UPSTREAM_FETCH_TIMEOUT_MS } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { hashIdentifier } from '~/server/utils/observability'
import { isAbortError } from '~/utils/errorHandling'

export interface ScreeningResult {
  addressIsSuspicious: boolean
}

interface ScreeningVerdictData {
  address: string
  addressIsSuspicious: boolean
  screenedAt: string
  resolvedChain: string
  cached: boolean
  ruleVersion: string
}

// Narrow the untrusted upstream payload to the complete documented success
// contract — a partial envelope (however plausible) is not a verdict.
function extractVerdictData(body: unknown): ScreeningVerdictData | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const candidate = data as Record<string, unknown>
  const valid
    = typeof candidate.address === 'string'
      && typeof candidate.addressIsSuspicious === 'boolean'
      && typeof candidate.screenedAt === 'string'
      && typeof candidate.resolvedChain === 'string'
      && typeof candidate.cached === 'boolean'
      && typeof candidate.ruleVersion === 'string'
  return valid ? (data as unknown as ScreeningVerdictData) : null
}

export function isValidScreeningAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isTruthyHeader(value: string | string[] | undefined): boolean {
  const headers = Array.isArray(value) ? value : [value]
  return headers
    .filter((header): header is string => typeof header === 'string')
    .flatMap(header => header.split(','))
    .some(token => token.trim().toLowerCase() === 'true')
}

function hasHeader(value: string | string[] | undefined): boolean {
  const values = Array.isArray(value) ? value : [value]
  return values.some(entry => typeof entry === 'string' && entry.trim() !== '')
}

// The VPN verdict comes from edge-set request headers, never from the client
// body — a client could otherwise clear its own flag. When neither header is
// present the measurement is unknown and reported as null (the upstream
// stores it as "not measured"), never as a fabricated false.
export function deriveVpnIsUsed(event: H3Event): boolean | null {
  const vpn = event.node.req.headers['x-is-vpn']
  const proxyOrVpn = event.node.req.headers['x-is-proxy-or-vpn']
  if (!hasHeader(vpn) && !hasHeader(proxyOrVpn)) {
    return null
  }
  return isTruthyHeader(vpn) || isTruthyHeader(proxyOrVpn)
}

// The restricted API key must only travel over TLS, and never follow a
// redirect (Node preserves request headers across cross-origin redirects).
// Plain http is tolerated for loopback targets only, so local dev against
// a local upstream keeps working.
function isAllowedScreeningUri(uri: string): boolean {
  try {
    const { protocol, hostname } = new URL(uri)
    if (protocol === 'https:') {
      return true
    }
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')
  }
  catch {
    return false
  }
}

/**
 * Screen an address against the data-v3 compliance API
 * (`POST /v3/compliance/address-screening`).
 *
 * Fail-closed: every branch other than an HTTP 200 carrying an explicit
 * `data.addressIsSuspicious: false` **for the requested address** reports the
 * address as suspicious — missing or non-TLS configuration, upstream errors,
 * timeouts, redirects, malformed or ambiguous verdicts, and verdicts echoing
 * a different address included.
 *
 * `chain` is deliberately omitted from the request: the upstream defaults to
 * `ethereum`, and unknown chain names would only trigger its provider
 * fallback path.
 */
export async function screenAddressUpstream(
  address: string,
  vpnIsUsed: boolean | null,
  logCtx: string,
): Promise<ScreeningResult> {
  const screeningUri = process.env.ADDRESS_SCREENING_URI
  const apiKey = process.env.ADDRESS_SCREENING_API_KEY

  // Screening is opt-in by configuration: with BOTH vars absent the app is
  // treated as a deployment without a screening provider (e.g. a fork) and
  // every address passes. Production (DOPPLER_ENVIRONMENT=prd — the same
  // convention the CORS/geo/rate middleware use) is the exception: there an
  // absent configuration is a failed secret injection, not an opt-out, and
  // it fails closed rather than silently disabling screening. Anything
  // partial is a misconfiguration in every environment — that fails closed.
  if (!screeningUri && !apiKey) {
    if (process.env.DOPPLER_ENVIRONMENT === 'prd') {
      logger.warn({ ctx: logCtx }, 'address screening not configured in production — failing closed')
      return { addressIsSuspicious: true }
    }
    logger.info({ ctx: logCtx }, 'address screening not configured — screening disabled, address passes')
    return { addressIsSuspicious: false }
  }

  if (!screeningUri || !apiKey) {
    logger.warn(
      { ctx: logCtx },
      'only one of ADDRESS_SCREENING_URI / ADDRESS_SCREENING_API_KEY is set — failing closed',
    )
    return { addressIsSuspicious: true }
  }

  if (!isAllowedScreeningUri(screeningUri)) {
    logger.warn(
      { ctx: logCtx },
      'ADDRESS_SCREENING_URI is not https (or local http) — refusing to send the API key, failing closed',
    )
    return { addressIsSuspicious: true }
  }

  try {
    const resp = await fetchWithTimeout(screeningUri, UPSTREAM_FETCH_TIMEOUT_MS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ address, vpnIsUsed }),
      redirect: 'error',
    })

    // The documented success contract is exactly HTTP 200 with a complete
    // envelope — any other 2xx is not a verdict.
    if (resp.status !== 200) {
      logger.warn({ ctx: logCtx, status: resp.status }, 'screening API non-200 response — failing closed')
      return { addressIsSuspicious: true }
    }

    const body: unknown = await resp.json()
    const data = extractVerdictData(body)
    const addressMatches
      = data !== null && data.address.toLowerCase() === address.toLowerCase()
    const isSuspicious = data === null || data.addressIsSuspicious !== false || !addressMatches

    if (isSuspicious) {
      logger.warn(
        { ctx: logCtx, addressHash: hashIdentifier(address), addressMatches },
        'flagged, malformed, or ambiguous screening response — failing closed',
      )
    }

    return { addressIsSuspicious: isSuspicious }
  }
  catch (error) {
    if (isAbortError(error)) {
      logger.warn({ ctx: logCtx }, 'screening API timeout — failing closed')
    }
    else {
      logger.warn({ ctx: logCtx, err: error }, 'screening API error — failing closed')
    }
    return { addressIsSuspicious: true }
  }
}
