import { createError, getHeader, readRawBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { isAbortError } from '~/utils/errorHandling'

const rateLimiter = createRateLimiter({
  max: 30,
  windowMs: 60_000,
  label: 'sentry-tunnel',
})

interface SentryEnvelopeHeader {
  dsn?: string
}

interface SentryEnvelopeItemHeader {
  type?: string
  length?: number
}

function buildIngestUrl(dsn: string): string {
  const url = new URL(dsn)
  const projectId = url.pathname.slice(1)
  return `https://${url.hostname}/api/${projectId}/envelope/`
}

function normalizeDsn(dsn: string): string {
  return dsn.trim().replace(/\/$/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonLine<T>(body: Buffer, offset: number): { value: T, nextOffset: number } {
  if (offset >= body.length) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
  }

  const newline = body.indexOf(10, offset)
  const lineEnd = newline === -1 ? body.length : newline

  try {
    return {
      value: JSON.parse(body.slice(offset, lineEnd).toString()) as T,
      nextOffset: newline === -1 ? body.length : newline + 1,
    }
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
  }
}

function readItemPayload(body: Buffer, itemHeader: SentryEnvelopeItemHeader, offset: number): { payload: Buffer, nextOffset: number } {
  if (typeof itemHeader.length === 'number') {
    if (!Number.isInteger(itemHeader.length) || itemHeader.length < 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
    }

    const payloadEnd = offset + itemHeader.length
    if (payloadEnd > body.length) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
    }

    return {
      payload: body.slice(offset, payloadEnd),
      nextOffset: body[payloadEnd] === 10 ? payloadEnd + 1 : payloadEnd,
    }
  }

  const newline = body.indexOf(10, offset)
  const payloadEnd = newline === -1 ? body.length : newline
  return {
    payload: body.slice(offset, payloadEnd),
    nextOffset: newline === -1 ? body.length : newline + 1,
  }
}

function validateBrowserEventPayload(itemType: string | undefined, payload: Buffer): void {
  if (itemType !== 'event' && itemType !== 'transaction' && itemType !== 'replay_event') {
    return
  }

  let eventPayload: unknown
  try {
    eventPayload = JSON.parse(payload.toString())
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
  }

  if (!isRecord(eventPayload)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
  }

  // The tunnel is only used by the browser SDK. Browser events should never
  // contain server-side identity fields; reject forged server events before
  // they can create alert noise in the Sentry project.
  if (typeof eventPayload.server_name === 'string' && eventPayload.server_name.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Sentry event' })
  }

  if (typeof eventPayload.platform === 'string' && eventPayload.platform !== 'javascript') {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Sentry event' })
  }

  const sdk = eventPayload.sdk
  if (isRecord(sdk) && typeof sdk.name === 'string' && !sdk.name.startsWith('sentry.javascript.')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Sentry event' })
  }
}

export function parseAndValidateSentryEnvelope(body: Buffer, sentryDsn: string): SentryEnvelopeHeader {
  const { value: envelopeHeader, nextOffset } = readJsonLine<unknown>(body, 0)
  const envelopeDsn = isRecord(envelopeHeader) && typeof envelopeHeader.dsn === 'string'
    ? envelopeHeader.dsn
    : ''

  if (normalizeDsn(envelopeDsn) !== normalizeDsn(sentryDsn)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid DSN' })
  }

  let offset = nextOffset
  while (offset < body.length) {
    const { value: itemHeader, nextOffset: payloadOffset } = readJsonLine<unknown>(body, offset)
    if (!isRecord(itemHeader)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
    }

    if ('length' in itemHeader && typeof itemHeader.length !== 'number') {
      throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
    }

    const normalizedItemHeader: SentryEnvelopeItemHeader = {
      type: typeof itemHeader.type === 'string' ? itemHeader.type : undefined,
      length: typeof itemHeader.length === 'number' ? itemHeader.length : undefined,
    }
    const { payload, nextOffset: nextItemOffset } = readItemPayload(body, normalizedItemHeader, payloadOffset)
    validateBrowserEventPayload(normalizedItemHeader.type, payload)
    offset = nextItemOffset
  }

  return { dsn: envelopeDsn }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const sentryDsn = useRuntimeConfig().public.sentryDsn
  if (!sentryDsn) {
    throw createError({ statusCode: 500, statusMessage: 'Sentry not configured' })
  }

  // Read as Buffer to preserve binary replay data (gzip-compressed envelopes)
  const body = await readRawBody(event, false)
  if (!body) {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' })
  }

  // Parse envelope header (first line) and validate the DSN to prevent
  // this endpoint from being used to relay events to arbitrary Sentry projects.
  // Also reject server-flavoured event payloads; this tunnel is only for the
  // browser SDK and must not be a shortcut for forged Node/server events.
  parseAndValidateSentryEnvelope(body, sentryDsn)

  const contentType = getHeader(event, 'content-type') ?? 'application/x-sentry-envelope'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    let response: Response
    try {
      response = await fetch(buildIngestUrl(sentryDsn), {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: body as unknown as BodyInit,
        signal: controller.signal,
      })
    }
    catch (error) {
      if (isAbortError(error)) {
        throw createError({ statusCode: 504, statusMessage: 'Sentry ingest timeout' })
      }
      throw createError({ statusCode: 502, statusMessage: 'Sentry ingest unreachable' })
    }

    if (!response.ok) {
      throw createError({ statusCode: 502, statusMessage: 'Sentry ingest error' })
    }
  }
  finally {
    clearTimeout(timeout)
  }
})
