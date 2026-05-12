import { afterEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { INTERNAL_FETCH_HEADERS } from '~/server/utils/internal-headers'
import geoGate from '~/server/middleware/geo-gate'

const ORIGINAL_DOPPLER_ENVIRONMENT = process.env.DOPPLER_ENVIRONMENT
const ORIGINAL_EDGE_ORIGIN_SECRET = process.env.EDGE_ORIGIN_SECRET
const ORIGINAL_DEV_GEO_COUNTRY = process.env.DEV_GEO_COUNTRY
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

const eventWithHeaders = (headers: Record<string, string | undefined>, url = '/api/vaults'): H3Event =>
  ({
    path: url,
    node: {
      req: {
        url,
        headers: {
          host: 'euler.example',
          ...headers,
        },
      },
    },
  }) as unknown as H3Event

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

describe('geo-gate trusted ingress', () => {
  it('rejects production API requests before trusting spoofable CF-IPCountry', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'

    expect(() => geoGate(eventWithHeaders({
      'cf-ipcountry': 'GB',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('accepts production API requests from trusted ingress with a non-sanctioned country', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'

    expect(() => geoGate(eventWithHeaders({
      'cf-ipcountry': 'GB',
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).not.toThrow()
  })

  it('lets private internal requests bypass production edge checks', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'

    expect(() => geoGate(eventWithHeaders({ ...INTERNAL_FETCH_HEADERS }))).not.toThrow()
  })

  it('rejects production requests without CF-IPCountry even when DEV_GEO_COUNTRY is set', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    process.env.DEV_GEO_COUNTRY = 'GB'

    expect(() => geoGate(eventWithHeaders({
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).toThrowError(expect.objectContaining({ statusCode: 451 }))
  })

  it('requires trusted ingress when NODE_ENV is production and DOPPLER_ENVIRONMENT is absent', () => {
    delete process.env.DOPPLER_ENVIRONMENT
    process.env.NODE_ENV = 'production'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'

    expect(() => geoGate(eventWithHeaders({
      'cf-ipcountry': 'GB',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })
})
