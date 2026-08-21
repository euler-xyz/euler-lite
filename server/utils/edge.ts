import type { H3Event } from 'h3'
import {
  EDGE_ORIGIN_AUTH_HEADER,
  edgeProvidesGeo,
  edgeRequiresOriginSecret,
  extractEdgeInputs,
  normalizeCountry,
  parseEdgeProvider,
} from '~/utils/edge-presets'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { timingSafeEqualStrings } from '~/server/utils/timing-safe'

/**
 * Normalized view of everything the fronting edge infrastructure tells us
 * about a request. Consumers (geo-gate, rate-limit, cors, screening) read
 * this instead of vendor headers; the vendor mapping lives exclusively in
 * `utils/edge-presets.ts`.
 */
export interface EdgeContext {
  /** Trusted client IP, or null when there is no trustworthy identity. */
  clientIp: string | null
  /** ISO 3166-1 alpha-2 country, or null when unmeasured. Includes the
   *  DEV_GEO_COUNTRY fallback (envs without a geo-capable edge). */
  country: string | null
  /** VPN/proxy evidence from the edge, or null when unmeasured. */
  vpnIsUsed: boolean | null
  /** Origin-auth secret verified, or no secret is configured. When false,
   *  the request bypassed the edge and every input above is null. */
  authenticated: boolean
  /** Server-internal $fetch call (see server/utils/internal-headers.ts). */
  isInternal: boolean
  /** Whether the configured preset is expected to provide a country —
   *  drives the geo-gate's fail-closed (451) branch. */
  providesGeo: boolean
}

export function getEdgeContext(event: H3Event): EdgeContext {
  const provider = parseEdgeProvider(process.env.EDGE_PROVIDER)
  const providesGeo = edgeProvidesGeo(provider)
  const secret = process.env.EDGE_ORIGIN_SECRET?.trim()
  const isInternal = isInternalRequest(event)
  const headers = event.node.req.headers

  const authHeader = headers[EDGE_ORIGIN_AUTH_HEADER]
  const authenticated = !secret
    || (typeof authHeader === 'string' && timingSafeEqualStrings(authHeader, secret))

  if (!authenticated) {
    // Origin auth is configured but this request doesn't carry the secret:
    // it bypassed the edge, so none of the edge-derived inputs can be
    // trusted. Reporting them as absent routes the request into every
    // consumer's fail-closed path. The DEV_GEO_COUNTRY fallback is skipped
    // for the same reason.
    return {
      clientIp: null,
      country: null,
      vpnIsUsed: null,
      authenticated: false,
      isInternal,
      providesGeo,
    }
  }

  const inputs = extractEdgeInputs(provider, headers, event.node.req.socket?.remoteAddress)
  return {
    ...inputs,
    // DEV_GEO_COUNTRY injects a country regardless of environment so
    // deployments without a geo-capable edge (local dev, PR previews) are
    // not universally fail-closed. Do not set it in production.
    country: inputs.country ?? normalizeCountry(process.env.DEV_GEO_COUNTRY),
    authenticated: true,
    isInternal,
    providesGeo,
  }
}

/**
 * Boot-time validation, called from `server/plugins/edge-guard.ts`.
 *
 * Throws on an unknown EDGE_PROVIDER value (any environment — a typo must
 * not silently degrade to `none`), when production boots without a
 * preset (under `none` geo-blocking is off and rate limiting falls back to
 * best-effort identity, which is fork-friendly but never acceptable for a
 * production deployment), and when a preset that mandates origin auth
 * runs without EDGE_ORIGIN_SECRET (see `edgeRequiresOriginSecret`).
 */
export function assertEdgeConfig(): void {
  const provider = parseEdgeProvider(process.env.EDGE_PROVIDER)
  if (process.env.DOPPLER_ENVIRONMENT === 'prd' && !process.env.EDGE_PROVIDER?.trim()) {
    throw new Error(
      'EDGE_PROVIDER must be set in production (DOPPLER_ENVIRONMENT=prd): '
      + 'without it geo-blocking is disabled and there is no trusted client identity. '
      + 'Set it to the deployment\'s fronting edge preset, or explicitly to "none" '
      + 'for a deployment that intentionally runs without one.',
    )
  }
  if (edgeRequiresOriginSecret(provider) && !process.env.EDGE_ORIGIN_SECRET?.trim()) {
    throw new Error(
      `EDGE_PROVIDER=${provider} requires EDGE_ORIGIN_SECRET: without origin auth `
      + 'this edge\'s trusted inputs would be forgeable by anyone who can reach the '
      + 'origin directly. Configure the edge to stamp x-edge-origin-auth and set '
      + 'the secret.',
    )
  }
}
