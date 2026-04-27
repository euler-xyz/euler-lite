import { createError, getRequestURL } from 'h3'
import { SANCTIONED_COUNTRIES } from '~/entities/country-constants'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { logger } from '~/server/utils/logger'

export default defineEventHandler((event) => {
  // Only gate API routes
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) {
    return
  }

  // Internal server-to-server $fetch calls (warm-cache, vaults-cache) skip
  // geo-gating — they never traversed Cloudflare and have no cf-ipcountry,
  // which would otherwise fail-closed and 451 every internal fetch. The
  // loopback cf-connecting-ip sentinel is the same signal the rate-limiter
  // uses to identify internal traffic; both rely on origin being locked
  // behind CF (see internal-headers.ts).
  if (isInternalRequest(event)) {
    return
  }

  // Use Cloudflare's CF-IPCountry header which is set by their edge network and
  // cannot be modified by clients. x-country-code is stripped in cors.ts.
  // CF-IPCountry special values: 'XX' = unknown IP, 'T1' = Tor exit node.
  const cfCountry = (event.node.req.headers['cf-ipcountry'] as string | undefined)?.toUpperCase()
  let country = (cfCountry && /^[A-Z]{2}$/.test(cfCountry) && cfCountry !== 'XX') ? cfCountry : undefined

  // When Cloudflare is not in the request path (local dev, PR previews, etc.)
  // cf-ipcountry is never set. DEV_GEO_COUNTRY allows injecting a country code
  // as a fallback regardless of environment, so preview deployments aren't
  // universally fail-closed when no CF header is present.
  if (!country) {
    const devCountry = process.env.DEV_GEO_COUNTRY?.toUpperCase()
    if (devCountry && /^[A-Z]{2}$/.test(devCountry) && devCountry !== 'XX') {
      country = devCountry
    }
  }

  // Fail-closed: deny access when country cannot be determined.
  // This prevents bypassing geo-blocks by omitting or spoofing headers.
  // In dev (DOPPLER_ENVIRONMENT=dev) without DEV_GEO_COUNTRY set, allow through.
  if (!country && process.env.DOPPLER_ENVIRONMENT !== 'dev') {
    logger.warn(
      { ctx: 'geo-gate', cfCountry: cfCountry || 'absent', path: url.pathname },
      'blocked: country undetermined',
    )
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }

  const isVpn = event.node.req.headers['x-is-vpn']
  const isProxyOrVpn = event.node.req.headers['x-is-proxy-or-vpn']

  // Log VPN/proxy usage for monitoring (do not block -- too many false positives)
  if (isVpn === 'true' || isProxyOrVpn === 'true') {
    logger.warn(
      { ctx: 'geo-gate', country, isVpn, isProxyOrVpn, path: url.pathname },
      'VPN/proxy detected',
    )
  }

  // Block sanctioned countries
  if (country && SANCTIONED_COUNTRIES.includes(country)) {
    logger.warn(
      { ctx: 'geo-gate', country, path: url.pathname },
      'blocked sanctioned country',
    )
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }
})
