import type { H3Event } from 'h3'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createError, getCookie, getRequestURL, setCookie, setResponseHeader, sendNoContent } from 'h3'
import { logger } from '~/server/utils/logger'
import { getEdgeContext } from '~/server/utils/edge'
import { isInternalRequest } from '~/server/utils/internal-headers'

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

// /api/internal/screen-address is also consumed cross-origin by first-party
// Euler SPAs that have no server of their own (create/redemptions/maglev
// .euler.finance). The exception is scoped to this single path so no other
// internal route is exposed to sibling apps; configured origins
// (CORS_ALLOWED_ORIGINS / dev localhost) keep working via the regular
// allowlist. It stays under /api/internal/ deliberately: the consumers are
// our own apps, and /api/public/ would advertise it to external integrators.
const SCREENING_PATH = '/api/internal/screen-address'

function isEulerFinanceOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== 'https:') {
      return false
    }
    return hostname === 'euler.finance' || hostname.endsWith('.euler.finance')
  }
  catch {
    return false
  }
}

const FIRST_PARTY_COOKIE_NAME = 'euler_lite_first_party'

// The cookie is an advisory first-party marker, not a security boundary:
// anyone can obtain it from `GET /`, and the internal sentinel
// (see server/utils/internal-headers.ts) bypasses this check entirely.
// Its job is to let same-origin browser GETs (which carry no Origin
// header) through the no-Origin rejection below.
//
// Derive the value from FIRST_PARTY_COOKIE_SECRET when configured so
// every replica and every deploy agrees on it. Without the secret, use
// the configured app/deployment origin as a stable non-secret seed; this
// keeps the advisory marker consistent behind a load balancer while
// preserving the existing dev fallback for ad-hoc local hosts.
const FIRST_PARTY_COOKIE_SECRET = process.env.FIRST_PARTY_COOKIE_SECRET?.trim()
const FIRST_PARTY_COOKIE_DEPLOYMENT_SEED
  = process.env.NUXT_PUBLIC_APP_URL?.trim()
    || process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
const FIRST_PARTY_COOKIE_VALUE = createHash('sha256')
  .update(FIRST_PARTY_COOKIE_SECRET
    ? `euler-lite-first-party-secret:${FIRST_PARTY_COOKIE_SECRET}`
    : `euler-lite-first-party-deployment:${FIRST_PARTY_COOKIE_DEPLOYMENT_SEED || randomBytes(32).toString('base64url')}`)
  .digest('base64url')
const FIRST_PARTY_COOKIE_BUFFER = Buffer.from(FIRST_PARTY_COOKIE_VALUE)

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function matchesFirstPartyCookie(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  // Compare byte lengths, not string lengths: a multibyte cookie value can
  // match the character count while timingSafeEqual throws on unequal buffers.
  const provided = Buffer.from(value)
  if (provided.length !== FIRST_PARTY_COOKIE_BUFFER.length) {
    return false
  }

  return timingSafeEqual(provided, FIRST_PARTY_COOKIE_BUFFER)
}

function isFirstPartyRequest(event: H3Event): boolean {
  return matchesFirstPartyCookie(getCookie(event, FIRST_PARTY_COOKIE_NAME))
}

function isSecureRequest(event: H3Event, url: URL): boolean {
  const forwardedProto = getSingleHeader(event.node.req.headers['x-forwarded-proto'])?.toLowerCase()
  return url.protocol === 'https:' || forwardedProto === 'https'
}

function shouldSetFirstPartyCookie(url: URL): boolean {
  return !url.pathname.startsWith('/_nuxt/') && !/\.[a-z0-9]+$/i.test(url.pathname)
}

function setFirstPartyCookie(event: H3Event, url: URL): void {
  setCookie(event, FIRST_PARTY_COOKIE_NAME, FIRST_PARTY_COOKIE_VALUE, {
    httpOnly: true,
    maxAge: 60 * 60 * 12,
    path: '/',
    sameSite: 'lax',
    secure: isSecureRequest(event, url),
  })
}

export default defineEventHandler((event) => {
  if (!allowedOrigins) {
    allowedOrigins = parseAllowedOrigins()
  }

  // Strip any client-supplied x-country-code to prevent geo-blocking bypass.
  // The authoritative value comes from the configured edge provider's trusted
  // header (see server/utils/edge.ts), which clients cannot modify. The
  // context also applies the DEV_GEO_COUNTRY fallback (mirroring geo-gate.ts)
  // so envs without a geo-capable edge still emit x-country-code.
  delete event.node.req.headers['x-country-code']

  const edge = getEdgeContext(event)

  if (edge.country) {
    setResponseHeader(event, 'x-country-code', edge.country)
  }
  else if (!edge.providesGeo || process.env.DOPPLER_ENVIRONMENT === 'dev') {
    // No geo evidence exists by design (`none` preset — forks, previews) or
    // this is local dev without DEV_GEO_COUNTRY — send a placeholder so the
    // client doesn't fail-closed. '--' is not a real country code so no
    // geo-blocks will trigger.
    setResponseHeader(event, 'x-country-code', '--')
  }

  const url = getRequestURL(event)

  if (!url.pathname.startsWith('/api/')) {
    if (shouldSetFirstPartyCookie(url)) {
      setFirstPartyCookie(event, url)
    }
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

  setResponseHeader(event, 'X-API-Stability', 'internal; may-break-without-notice')

  const origin = event.node.req.headers.origin

  if (origin && (allowedOrigins.has(origin) || (url.pathname === SCREENING_PATH && isEulerFinanceOrigin(origin)))) {
    setResponseHeader(event, 'Access-Control-Allow-Origin', origin)
  }
  else if (origin && process.env.DOPPLER_ENVIRONMENT !== 'dev') {
    if (allowedOrigins.size > 0) {
      logger.warn({ ctx: 'cors', origin }, 'rejected origin not in allow list')
    }
    throw createError({ statusCode: 403, statusMessage: 'Origin not allowed' })
  }
  else if (!origin && !isFirstPartyRequest(event) && !isInternalRequest(event) && process.env.DOPPLER_ENVIRONMENT !== 'dev') {
    // Re-issue the cookie on the rejection so a browser tab holding a stale
    // or expired cookie (redeploy, 12h maxAge) recovers on its next request
    // instead of being broken until a hard reload. Error responses are
    // forced no-store (see cache-error-responses), so this never reaches a
    // shared CDN cache.
    setFirstPartyCookie(event, url)
    logger.warn({ ctx: 'cors', path: url.pathname }, 'rejected internal endpoint call without Origin')
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        message: '/api/internal/* is not a public contract. See docs/public-api.md.',
      },
    })
  }

  setResponseHeader(event, 'Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  setResponseHeader(event, 'Access-Control-Allow-Headers', 'Content-Type')

  if (event.node.req.method === 'OPTIONS') {
    setResponseHeader(event, 'Access-Control-Max-Age', 86400)
    return sendNoContent(event)
  }
})
