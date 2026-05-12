import { afterEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import cors from '~/server/middleware/cors'
import { INTERNAL_FETCH_HEADERS } from '~/server/utils/internal-headers'

const ORIGINAL_DOPPLER_ENVIRONMENT = process.env.DOPPLER_ENVIRONMENT
const ORIGINAL_EDGE_ORIGIN_SECRET = process.env.EDGE_ORIGIN_SECRET
const ORIGINAL_DEV_GEO_COUNTRY = process.env.DEV_GEO_COUNTRY
const ORIGINAL_NODE_ENV = process.env.NODE_ENV
const CONFIGURED_APP_URL = process.env.NUXT_PUBLIC_APP_URL || 'https://external-host.example'

const eventWithHeaders = (
  headers: Record<string, string | undefined>,
  url = '/',
  method = 'HEAD',
): { event: H3Event, responseHeaders: Record<string, string> } => {
  const responseHeaders: Record<string, string> = {}
  const event = {
    path: url,
    node: {
      req: {
        url,
        method,
        headers: {
          host: 'euler.example',
          ...headers,
        },
      },
      res: {
        setHeader: (name: string, value: string) => {
          responseHeaders[name.toLowerCase()] = value
        },
        removeHeader: (name: string) => {
          responseHeaders[name.toLowerCase()] = ''
        },
        writeHead: () => {},
        end: () => {},
      },
    },
  } as unknown as H3Event

  return { event, responseHeaders }
}

afterEach(() => {
  if (ORIGINAL_DOPPLER_ENVIRONMENT === undefined) delete process.env.DOPPLER_ENVIRONMENT
  else process.env.DOPPLER_ENVIRONMENT = ORIGINAL_DOPPLER_ENVIRONMENT

  if (ORIGINAL_EDGE_ORIGIN_SECRET === undefined) delete process.env.EDGE_ORIGIN_SECRET
  else process.env.EDGE_ORIGIN_SECRET = ORIGINAL_EDGE_ORIGIN_SECRET

  if (ORIGINAL_DEV_GEO_COUNTRY === undefined) delete process.env.DEV_GEO_COUNTRY
  else process.env.DEV_GEO_COUNTRY = ORIGINAL_DEV_GEO_COUNTRY

  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV
})

describe('cors country header', () => {
  it('does not trust spoofable CF-IPCountry in production without trusted ingress', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event, responseHeaders } = eventWithHeaders({ 'cf-ipcountry': 'GB' })

    cors(event)

    expect(responseHeaders['x-country-code']).toBeUndefined()
  })

  it('sets x-country-code from Cloudflare country after trusted ingress is verified', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event, responseHeaders } = eventWithHeaders({
      'cf-ipcountry': 'GB',
      'x-euler-edge-origin-secret': 'edge-secret',
    })

    cors(event)

    expect(responseHeaders['x-country-code']).toBe('GB')
  })

  it('strips client-supplied x-country-code before processing', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event } = eventWithHeaders({
      'cf-ipcountry': 'GB',
      'x-country-code': 'US',
      'x-euler-edge-origin-secret': 'edge-secret',
    })

    cors(event)

    expect(event.node.req.headers['x-country-code']).toBeUndefined()
  })

  it('does not use DEV_GEO_COUNTRY as a production country fallback', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    process.env.DEV_GEO_COUNTRY = 'GB'
    const { event, responseHeaders } = eventWithHeaders({
      'x-euler-edge-origin-secret': 'edge-secret',
    })

    cors(event)

    expect(responseHeaders['x-country-code']).toBeUndefined()
  })

  it('rejects production API preflights without trusted ingress', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event } = eventWithHeaders({
      'origin': CONFIGURED_APP_URL,
      'access-control-request-method': 'POST',
    }, '/api/vaults', 'OPTIONS')

    expect(() => cors(event)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('rejects production API preflights when NODE_ENV is production and DOPPLER_ENVIRONMENT is absent', () => {
    delete process.env.DOPPLER_ENVIRONMENT
    process.env.NODE_ENV = 'production'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event } = eventWithHeaders({
      'origin': CONFIGURED_APP_URL,
      'access-control-request-method': 'POST',
    }, '/api/vaults', 'OPTIONS')

    expect(() => cors(event)).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('lets private internal API requests pass the production CORS ingress check', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const { event } = eventWithHeaders({ ...INTERNAL_FETCH_HEADERS }, '/api/euler-chains', 'GET')

    expect(() => cors(event)).not.toThrow()
  })

  it('treats padded dev environment values as development', () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev '
    const { event, responseHeaders } = eventWithHeaders({})

    cors(event)

    expect(responseHeaders['x-country-code']).toBe('--')
  })
})
