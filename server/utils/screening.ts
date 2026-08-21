import type { H3Event } from 'h3'
import { fetchWithTimeout, UPSTREAM_FETCH_TIMEOUT_MS } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { hashIdentifier } from '~/server/utils/observability'
import { isAbortError } from '~/utils/errorHandling'

export interface ScreeningResult {
  addressIsSuspicious: boolean
}

interface ScreeningVerdictData {
  address?: unknown
  addressIsSuspicious?: unknown
}

// Narrow the untrusted upstream payload without asserting anything about the
// verdict fields themselves — their validation stays with the caller.
function extractVerdictData(body: unknown): ScreeningVerdictData | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) {
    return null
  }
  return data as ScreeningVerdictData
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
  return Array.isArray(value) ? value.length > 0 : value !== undefined
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
  // every address passes. Anything partial is a misconfiguration of a
  // deployment that intended to screen — that fails closed.
  if (!screeningUri && !apiKey) {
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

    if (!resp.ok) {
      logger.warn({ ctx: logCtx, status: resp.status }, 'screening API non-ok response — failing closed')
      return { addressIsSuspicious: true }
    }

    const body: unknown = await resp.json()
    const data = extractVerdictData(body)
    const verdict = data?.addressIsSuspicious
    const echoedAddress = data?.address
    const addressMatches
      = typeof echoedAddress === 'string'
        && echoedAddress.toLowerCase() === address.toLowerCase()
    const isSuspicious = verdict !== false || !addressMatches

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
