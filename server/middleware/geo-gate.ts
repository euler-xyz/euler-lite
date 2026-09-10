import { createError, getRequestURL } from 'h3'
import { SANCTIONED_COUNTRIES } from '~/entities/country-constants'
import { getEdgeContext } from '~/server/utils/edge'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { logger } from '~/server/utils/logger'
import { safePathTemplate } from '~/server/utils/observability'

export default defineEventHandler((event) => {
  // Only gate API routes
  const url = getRequestURL(event)
  if (!url.pathname.startsWith('/api/')) {
    return
  }

  // Internal server-to-server $fetch calls (warm-cache, vaults-cache) skip
  // geo-gating — they never traversed the edge and carry no country, which
  // would otherwise fail-closed and 451 every internal fetch. See
  // server/utils/internal-headers.ts for the trust model.
  if (isInternalRequest(event)) {
    return
  }

  // The country comes from the configured edge provider's trusted header
  // (see server/utils/edge.ts) — clients cannot modify it, and any
  // client-supplied x-country-code is stripped in cors.ts. The context also
  // applies the DEV_GEO_COUNTRY fallback for envs without a geo-capable
  // edge (local dev, PR previews), so those aren't universally fail-closed.
  const edge = getEdgeContext(event)
  const country = edge.country

  // Fail-closed: when the edge is expected to provide a country but none
  // was determined, deny access. This prevents bypassing geo-blocks by
  // omitting or spoofing headers. Not applied under the `none` preset
  // (no geo evidence exists by design — forks, previews) or in dev
  // (DOPPLER_ENVIRONMENT=dev) without DEV_GEO_COUNTRY set.
  if (!country && edge.providesGeo && process.env.DOPPLER_ENVIRONMENT !== 'dev') {
    logger.warn(
      { ctx: 'geo-gate', pathTemplate: safePathTemplate(url.pathname) },
      'blocked: country undetermined',
    )
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }

  // Log VPN/proxy usage for monitoring (do not block -- too many false positives)
  if (edge.vpnIsUsed === true) {
    logger.warn(
      { ctx: 'geo-gate', country, vpnIsUsed: true, pathTemplate: safePathTemplate(url.pathname) },
      'VPN/proxy detected',
    )
  }

  // Block sanctioned countries
  if (country && SANCTIONED_COUNTRIES.includes(country)) {
    logger.warn(
      { ctx: 'geo-gate', country, pathTemplate: safePathTemplate(url.pathname) },
      'blocked sanctioned country',
    )
    throw createError({
      statusCode: 451,
      statusMessage: 'Unavailable For Legal Reasons',
    })
  }
})
