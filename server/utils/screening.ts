import type { H3Event } from 'h3'
import { fetchWithTimeout, UPSTREAM_FETCH_TIMEOUT_MS } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { hashIdentifier } from '~/server/utils/observability'
import { isAbortError } from '~/utils/errorHandling'

export interface ScreeningResult {
  addressIsSuspicious: boolean
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

// The VPN verdict comes from edge-set request headers, never from the client
// body — a client could otherwise clear its own flag.
export function deriveVpnIsUsed(event: H3Event): boolean {
  return isTruthyHeader(event.node.req.headers['x-is-vpn'])
    || isTruthyHeader(event.node.req.headers['x-is-proxy-or-vpn'])
}

/**
 * Screen an address against the data-v3 compliance API
 * (`POST /v3/compliance/address-screening`).
 *
 * Fail-closed: every branch other than an HTTP 200 carrying an explicit
 * `data.addressIsSuspicious: false` reports the address as suspicious —
 * missing configuration, upstream errors, timeouts, and malformed or
 * ambiguous verdicts included.
 *
 * `chain` is deliberately omitted from the request: the upstream defaults to
 * `ethereum`, and unknown chain names would only trigger its provider
 * fallback path.
 */
export async function screenAddressUpstream(
  address: string,
  vpnIsUsed: boolean,
  logCtx: string,
): Promise<ScreeningResult> {
  const screeningUri = process.env.ADDRESS_SCREENING_URI
  const apiKey = process.env.ADDRESS_SCREENING_API_KEY

  if (!screeningUri || !apiKey) {
    logger.warn(
      { ctx: logCtx },
      'ADDRESS_SCREENING_URI or ADDRESS_SCREENING_API_KEY is not set — failing closed',
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
    })

    if (!resp.ok) {
      logger.warn({ ctx: logCtx, status: resp.status }, 'screening API non-ok response — failing closed')
      return { addressIsSuspicious: true }
    }

    const body = await resp.json()
    const isSuspicious = body?.data?.addressIsSuspicious !== false

    if (isSuspicious) {
      logger.warn(
        { ctx: logCtx, addressHash: hashIdentifier(address) },
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
