import { describe, expect, it } from 'vitest'
import { parseAndValidateSentryEnvelope } from '~/server/api/sentry-tunnel.post'

const DSN = 'https://public@example.ingest.sentry.io/123'

function envelope(items: Array<{ header: Record<string, unknown>, payload: unknown }>, dsn = DSN): Buffer {
  return Buffer.from([
    JSON.stringify({ dsn, sent_at: '2026-05-11T00:00:00.000Z' }),
    ...items.flatMap(item => [
      JSON.stringify(item.header),
      typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload),
    ]),
  ].join('\n'))
}

describe('parseAndValidateSentryEnvelope', () => {
  it('accepts browser SDK event envelopes for the configured DSN', () => {
    const body = envelope([
      {
        header: { type: 'event' },
        payload: {
          event_id: '0'.repeat(32),
          platform: 'javascript',
          sdk: { name: 'sentry.javascript.nuxt', version: '10.50.0' },
          message: 'real browser error',
        },
      },
    ])

    expect(parseAndValidateSentryEnvelope(body, DSN)).toMatchObject({ dsn: DSN })
  })

  it('rejects envelopes for another Sentry project', () => {
    const body = envelope([
      {
        header: { type: 'event' },
        payload: {
          platform: 'javascript',
          sdk: { name: 'sentry.javascript.nuxt', version: '10.50.0' },
          message: 'wrong project',
        },
      },
    ], 'https://public@example.ingest.sentry.io/999')

    expect(() => parseAndValidateSentryEnvelope(body, DSN)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('rejects forged server-name event payloads', () => {
    const body = envelope([
      {
        header: { type: 'event' },
        payload: {
          platform: 'javascript',
          sdk: { name: 'sentry.javascript.nuxt', version: '10.50.0' },
          server_name: 'external-host',
          message: 'server-side event',
        },
      },
    ])

    expect(() => parseAndValidateSentryEnvelope(body, DSN)).toThrow(expect.objectContaining({
      statusCode: 400,
      statusMessage: 'Invalid Sentry event',
    }))
  })

  it('rejects non-browser SDK event payloads', () => {
    const body = envelope([
      {
        header: { type: 'event' },
        payload: {
          platform: 'node',
          sdk: { name: 'sentry.javascript.node', version: '10.50.0' },
          message: 'server event',
        },
      },
    ])

    expect(() => parseAndValidateSentryEnvelope(body, DSN)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})
