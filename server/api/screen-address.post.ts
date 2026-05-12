import { createError, readBody, type H3Event } from 'h3'
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

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value ?? '').trim().toLowerCase()
}

function isTruthyHeader(value: string | string[] | undefined): boolean {
  return ['1', 'true', 'yes'].includes(headerValue(value))
}

interface ScreeningPayload {
  address: string
  chain: 'all'
  vpnIsUsed: string
}

export function getTrustedVpnIsUsed(event: H3Event): boolean {
  const headers = event.node.req.headers
  return isTruthyHeader(headers['x-is-vpn']) || isTruthyHeader(headers['x-is-proxy-or-vpn'])
}

export function buildScreeningPayload(address: string, event: H3Event): ScreeningPayload {
  return {
    address,
    chain: 'all',
    vpnIsUsed: String(getTrustedVpnIsUsed(event)),
  }
}

export function isAddressSuspiciousResponse(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return true
  }
  return (data as { addressIsSuspicious?: unknown }).addressIsSuspicious !== false
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody(event)

  if (!body || !isValidAddress(body.address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  const address = body.address

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
      body: JSON.stringify(buildScreeningPayload(address, event)),
      signal: controller.signal,
    })

    if (!resp.ok) {
      logger.warn({ ctx: 'screen-address', status: resp.status }, 'TRM API non-ok response — failing closed')
      return { addressIsSuspicious: true }
    }

    const data = await resp.json()
    const isSuspicious = isAddressSuspiciousResponse(data)

    if (isSuspicious) {
      logger.warn({ ctx: 'screen-address', address }, 'flagged address')
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
