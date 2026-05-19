import { createError, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { UPSTREAM_FETCH_TIMEOUT_MS } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { isAbortError } from '~/utils/errorHandling'

const rateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
  label: 'screen-address',
})

function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isTruthyHeader(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value
  return header === 'true'
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody(event)

  if (!body || !isValidAddress(body.address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  const address = body.address
  const vpnIsUsed = String(
    isTruthyHeader(event.node.req.headers['x-is-vpn'])
    || isTruthyHeader(event.node.req.headers['x-is-proxy-or-vpn']),
  )

  const screeningUri = process.env.WALLET_SCREENING_URI

  if (!screeningUri) {
    logger.warn({ ctx: 'screen-address' }, 'WALLET_SCREENING_URI is not set — failing closed')
    return { addressIsSuspicious: true }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_FETCH_TIMEOUT_MS)

  try {
    const resp = await fetch(screeningUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, chain: 'all', vpnIsUsed }),
      signal: controller.signal,
    })

    if (!resp.ok) {
      logger.warn({ ctx: 'screen-address', status: resp.status }, 'TRM API non-ok response — failing closed')
      return { addressIsSuspicious: true }
    }

    const data = await resp.json()
    const isSuspicious = data?.addressIsSuspicious !== false

    if (isSuspicious) {
      logger.warn({ ctx: 'screen-address', address }, 'flagged, malformed, or ambiguous TRM response — failing closed')
    }

    return { addressIsSuspicious: isSuspicious }
  }
  catch (error) {
    if (isAbortError(error)) {
      logger.warn({ ctx: 'screen-address' }, 'TRM API timeout — failing closed')
    }
    else {
      logger.warn({ ctx: 'screen-address', err: error }, 'TRM API error — failing closed')
    }
    return { addressIsSuspicious: true }
  }
  finally {
    clearTimeout(timeout)
  }
})
