import { createError, getMethod, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'
import { sanitizeClientObservabilityInput, shouldSampleClientPayload } from '~/utils/client-observability'

const MAX_PAYLOAD_BYTES = 12 * 1024

const rateLimiter = createRateLimiter({
  max: 120,
  windowMs: 60_000,
  label: 'client-error',
})

export default defineEventHandler(async (event) => {
  if (getMethod(event).toUpperCase() !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const contentLength = Number(event.node.req.headers['content-length'] ?? 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_PAYLOAD_BYTES) {
    logger.warn({ ctx: 'client-error', reason: 'payload-too-large', contentLength, limit: MAX_PAYLOAD_BYTES }, 'request rejected')
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  rateLimiter.consume(event)

  const body = await readBody(event)
  const measuredBytes = Buffer.byteLength(JSON.stringify(body ?? ''), 'utf8')
  if (measuredBytes > MAX_PAYLOAD_BYTES) {
    logger.warn({ ctx: 'client-error', reason: 'payload-too-large', contentLength: measuredBytes, limit: MAX_PAYLOAD_BYTES }, 'request rejected')
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }

  const payload = sanitizeClientObservabilityInput(body)
  if (!payload) {
    logger.warn({ ctx: 'client-error', reason: 'invalid-payload' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid client error payload' })
  }

  if (!shouldSampleClientPayload(payload)) {
    return { ok: true, sampled: false }
  }

  logger.error(
    {
      ctx: 'client-error',
      ...payload,
    },
    payload.message || payload.event,
  )

  return { ok: true }
})
