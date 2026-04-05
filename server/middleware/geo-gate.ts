import { createError, getRequestURL } from 'h3'
import { SANCTIONED_COUNTRIES } from '~/entities/country-constants'

export default defineEventHandler((event) => {
  // Only gate API routes
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) {
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
    console.warn('[geo-gate] Blocked: country undetermined', {
      cfCountry: cfCountry || 'absent',
      path: url.pathname,
    })
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }

  const isVpn = event.node.req.headers['x-is-vpn']
  const isProxyOrVpn = event.node.req.headers['x-is-proxy-or-vpn']

  // Log VPN/proxy usage for monitoring (do not block -- too many false positives)
  if (isVpn === 'true' || isProxyOrVpn === 'true') {
    console.warn('[geo-gate] VPN/proxy detected', {
      country,
      isVpn,
      isProxyOrVpn,
      path: url.pathname,
    })
  }

  // Block sanctioned countries
  if (country && SANCTIONED_COUNTRIES.includes(country)) {
    console.warn('[geo-gate] Blocked sanctioned country', {
      country,
      path: url.pathname,
    })
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }
})
