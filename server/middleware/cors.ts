import { createError, getRequestURL, setResponseHeader, sendNoContent } from 'h3'
import { logger } from '~/utils/logger'

function parseAllowedOrigins(): Set<string> {
  // CORS_ALLOWED_ORIGINS is the dedicated CORS var (comma-separated).
  // Falls back to NUXT_PUBLIC_APP_URL (single origin used by Reown/AppKit).
  const corsOrigins = process.env.CORS_ALLOWED_ORIGINS?.trim()
  const appUrl = process.env.NUXT_PUBLIC_APP_URL?.trim()
  const isDev = process.env.DOPPLER_ENVIRONMENT === 'dev'

  const origins = new Set<string>()

  if (isDev) {
    const ports = [3000, 3001, 3002, 3003]
    for (const port of ports) {
      origins.add(`http://localhost:${port}`)
      origins.add(`https://localhost:${port}`)
      origins.add(`http://127.0.0.1:${port}`)
      origins.add(`https://127.0.0.1:${port}`)
    }
  }

  if (corsOrigins) {
    corsOrigins.split(',').forEach(url => origins.add(url.trim()))
  }
  else if (appUrl && appUrl !== '*') {
    origins.add(appUrl)
  }

  // Railway preview deployments: auto-allow the deployment's own domain
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
  if (railwayDomain) {
    origins.add(`https://${railwayDomain}`)
  }

  return origins
}

let allowedOrigins: Set<string> | null = null

export default defineEventHandler((event) => {
  if (!allowedOrigins) {
    allowedOrigins = parseAllowedOrigins()
  }

  // Strip any client-supplied x-country-code to prevent geo-blocking bypass.
  // The authoritative value comes from Cloudflare's CF-IPCountry header which is
  // set by their edge network and cannot be modified by clients.
  delete event.node.req.headers['x-country-code']

  const cfCountry = (event.node.req.headers['cf-ipcountry'] as string | undefined)?.toUpperCase()
  let country = (cfCountry && /^[A-Z]{2}$/.test(cfCountry) && cfCountry !== 'XX') ? cfCountry : undefined

  // When Cloudflare is not in the request path (local dev, PR previews, etc.)
  // cf-ipcountry is never set. Mirror geo-gate.ts: use DEV_GEO_COUNTRY as a
  // fallback regardless of environment so x-country-code is set in the response.
  if (!country) {
    const devCountry = process.env.DEV_GEO_COUNTRY?.toUpperCase()
    if (devCountry && /^[A-Z]{2}$/.test(devCountry) && devCountry !== 'XX') {
      country = devCountry
    }
  }

  if (country) {
    setResponseHeader(event, 'x-country-code', country)
  }
  else if (process.env.DOPPLER_ENVIRONMENT === 'dev') {
    // No DEV_GEO_COUNTRY set — send a placeholder so the client doesn't fail-closed.
    // '--' is not a real country code so no geo-blocks will trigger.
    setResponseHeader(event, 'x-country-code', '--')
  }

  const url = getRequestURL(event)

  if (!url.pathname.startsWith('/api/')) {
    return
  }

  // Always set Vary: Origin so CDNs/proxies don't serve a cached
  // response (including preflights) for one origin to another.
  setResponseHeader(event, 'Vary', 'Origin')

  // Endpoints under /api/public/ are intentionally public.
  if (url.pathname.startsWith('/api/public/')) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
    setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, OPTIONS')
    setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')
    if (event.node.req.method === 'OPTIONS') {
      setResponseHeader(event, 'Access-Control-Max-Age', 86400)
      return sendNoContent(event)
    }
    return
  }

  const origin = event.node.req.headers.origin

  if (origin && allowedOrigins.has(origin)) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', origin)
  }
  else if (origin && process.env.DOPPLER_ENVIRONMENT !== 'dev') {
    if (allowedOrigins.size > 0) {
      logger.warn({ ctx: 'cors', origin }, 'rejected origin not in allow list')
    }
    throw createError({ statusCode: 403, statusMessage: 'Origin not allowed' })
  }

  setResponseHeader(event, 'Access-Control-Allow-Methods', 'POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')

  if (event.node.req.method === 'OPTIONS') {
    setResponseHeader(event, 'Access-Control-Max-Age', 86400)
    return sendNoContent(event)
  }
})
