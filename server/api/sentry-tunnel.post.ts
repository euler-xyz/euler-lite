import { createError, getHeader, readRawBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { isAbortError } from '~/utils/errorHandling'

const rateLimiter = createRateLimiter({
  max: 30,
  windowMs: 60_000,
  label: 'sentry-tunnel',
})

function buildIngestUrl(dsn: string): string {
  const url = new URL(dsn)
  const projectId = url.pathname.slice(1)
  return `https://${url.hostname}/api/${projectId}/envelope/`
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
  let envelopeHeader: { dsn?: string }
  try {
    envelopeHeader = JSON.parse(body.slice(0, body.indexOf(10)).toString())
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid envelope' })
  }

  const normalize = (dsn: string) => dsn.trim().replace(/\/$/, '')
  if (normalize(envelopeHeader.dsn ?? '') !== normalize(sentryDsn)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid DSN' })
  }

  const contentType = getHeader(event, 'content-type') ?? 'application/x-sentry-envelope'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    let response: Response
    try {
      response = await fetch(buildIngestUrl(sentryDsn), {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
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
