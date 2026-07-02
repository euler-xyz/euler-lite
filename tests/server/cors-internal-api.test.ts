import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getCookie: (event: TestEvent, name: string) => event.cookies[name],
  getRequestURL: (event: TestEvent) => new URL(event.url),
  sendNoContent: vi.fn(() => undefined),
  setCookie: (event: TestEvent, name: string, value: string) => {
    event.cookies[name] = value
  },
  setResponseHeader: (event: TestEvent, name: string, value: number | string) => {
    event.headers[name] = String(value)
  },
}))

vi.mock('~/server/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}))

type TestEvent = {
  url: string
  cookies: Record<string, string>
  headers: Record<string, string>
  node: {
    req: {
      method: string
      headers: Record<string, string | undefined>
      socket: {
        remoteAddress?: string
      }
    }
  }
}

const makeEvent = (
  path: string,
  headers: Record<string, string | undefined> = {},
  method = 'GET',
  cookies: Record<string, string> = {},
  remoteAddress?: string,
): TestEvent => ({
  url: `https://app.example${path}`,
  cookies: { ...cookies },
  headers: {},
  node: {
    req: {
      method,
      headers,
      socket: {
        remoteAddress,
      },
    },
  },
})

const loadHandler = async () => {
  vi.resetModules()
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  return (await import('~/server/middleware/cors')).default as unknown as (event: TestEvent) => unknown
}

const getFirstPartyCookies = (handler: (event: TestEvent) => unknown): Record<string, string> => {
  const event = makeEvent('/')
  expect(handler(event)).toBeUndefined()
  expect(Object.keys(event.cookies)).toHaveLength(1)
  return event.cookies
}

describe('cors internal API boundary', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('allows public API endpoints from any origin', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/api/public/is-known')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['Access-Control-Allow-Origin']).toBe('*')
    expect(event.headers['X-API-Stability']).toBeUndefined()
  })

  it('marks internal API responses as unstable for allowed app origins', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://app.example')
    const handler = await loadHandler()
    const event = makeEvent('/api/internal/vaults', { origin: 'https://app.example' })

    expect(handler(event)).toBeUndefined()
    expect(event.headers['Access-Control-Allow-Origin']).toBe('https://app.example')
    expect(event.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })

  it('sets a first-party cookie on app shell requests', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/')

    expect(handler(event)).toBeUndefined()
    expect(Object.values(event.cookies)[0]).toEqual(expect.any(String))
  })

  it('allows first-party no-Origin production internal API reads', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/api/internal/token-list', {}, 'GET', getFirstPartyCookies(handler))

    expect(handler(event)).toBeUndefined()
    expect(event.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS')
    expect(event.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })

  it('rejects external no-Origin production internal API reads without a first-party cookie', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/token-list'))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('rejects spoofed same-origin fetch metadata without a first-party cookie', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/euler-chains', { 'sec-fetch-site': 'same-origin' }))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('rejects external no-Origin production internal API writes without a first-party cookie', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/rpc/1', {}, 'POST'))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('allows first-party no-Origin production internal API writes', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/api/internal/rpc/1', {}, 'POST', getFirstPartyCookies(handler))

    expect(handler(event)).toBeUndefined()
    expect(event.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })

  it('allows loopback server-side internal requests without Origin', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/api/internal/euler-chains', {}, 'GET', {}, '127.0.0.1')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })

  it('allows same-process internal requests with the internal sentinel', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const internalEvent = makeEvent('/api/internal/vaults', { 'cf-connecting-ip': '127.0.0.1' })

    expect(handler(internalEvent)).toBeUndefined()
    expect(internalEvent.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })
})
