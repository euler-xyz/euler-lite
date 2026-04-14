import type { H3Event } from 'h3'
import { setResponseHeader } from 'h3'

const isDev = process.env.DOPPLER_ENVIRONMENT === 'dev'

/**
 * Pure header application so this logic can be unit-tested without
 * Nitro's auto-imported defineEventHandler wrapper. See
 * tests/server/security.test.ts.
 */
export function applySecurityHeaders(event: H3Event): void {
  // Prevent clickjacking: deny all framing (legacy header, CSP frame-ancestors
  // is the modern equivalent — we set both for belt-and-suspenders).
  setResponseHeader(event, 'X-Frame-Options', 'DENY')

  // Prevent MIME-type sniffing
  setResponseHeader(event, 'X-Content-Type-Options', 'nosniff')

  // Control referrer information leakage
  setResponseHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')

  // Restrict browser features the app does not need
  setResponseHeader(event, 'Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

  // Isolate the browsing context group so a cross-origin window cannot
  // hold a reference to ours via window.opener. `same-origin-allow-popups`
  // is the strictest value that still lets Reown AppKit and Coinbase
  // Wallet SDK open wallet popups — strict `same-origin` would break them.
  setResponseHeader(event, 'Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

  // HSTS: only in production (localhost uses plain HTTP in dev)
  if (!isDev) {
    setResponseHeader(
      event,
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload',
    )
  }
}

export default defineEventHandler((event) => {
  applySecurityHeaders(event)
})
