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
    vi.stubEnv('NUXT_PUBLIC_APP_URL', 'https://app.example')
  })

  it('allows public API endpoints from any origin', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const event = makeEvent('/api/public/is-known')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['Access-Control-Allow-Origin']).toBe('*')
    expect(event.headers['X-API-Stability']).toBeUndefined()
  })

  it('allows the internal screening route from *.euler.finance origins', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    for (const origin of ['https://create.euler.finance', 'https://redemptions.euler.finance', 'https://maglev.euler.finance', 'https://euler.finance']) {
      const event = makeEvent('/api/internal/screen-address', { origin }, 'POST')
      expect(handler(event)).toBeUndefined()
      expect(event.headers['Access-Control-Allow-Origin']).toBe(origin)
      expect(event.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
    }
  })

  it('allows the internal screening route from configured CORS origins', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://preview.example')
    const handler = await loadHandler()
    const event = makeEvent('/api/internal/screen-address', { origin: 'https://preview.example' }, 'POST')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['Access-Control-Allow-Origin']).toBe('https://preview.example')
  })

  it('rejects the screening route for lookalike and non-https origins', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    for (const origin of [
      'https://evil-euler.finance',
      'https://euler.finance.evil.com',
      'https://xeuler.finance',
      'http://create.euler.finance',
      'null',
    ]) {
      try {
        handler(makeEvent('/api/internal/screen-address', { origin }, 'POST'))
        throw new Error(`Expected origin to be rejected: ${origin}`)
      }
      catch (err) {
        expect(err).toMatchObject({ statusCode: 403, statusMessage: 'Origin not allowed' })
      }
    }
  })

  it('does not extend the *.euler.finance exception to other internal routes', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/vaults', { origin: 'https://create.euler.finance' }))
      throw new Error('Expected origin to be rejected on a non-screening route')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 403, statusMessage: 'Origin not allowed' })
    }
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

  it('rejects a malformed multibyte cookie value with 403 instead of crashing', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    // Same character count as the expected value (43) but more bytes —
    // must not reach timingSafeEqual with unequal buffer lengths.
    const malformed = `é${'a'.repeat(42)}`

    try {
      handler(makeEvent('/api/internal/token-list', {}, 'GET', { euler_lite_first_party: malformed }))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('re-issues the first-party cookie on the no-Origin rejection so browsers can recover', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    const rejected = makeEvent('/api/internal/token-list')

    try {
      handler(rejected)
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 403 })
    }

    expect(Object.keys(rejected.cookies)).toHaveLength(1)

    const retried = makeEvent('/api/internal/token-list', {}, 'GET', rejected.cookies)
    expect(handler(retried)).toBeUndefined()
  })

  it('derives a stable first-party cookie value across processes when the secret is set', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('FIRST_PARTY_COOKIE_SECRET', 'stable-secret')
    const first = getFirstPartyCookies(await loadHandler())
    const second = getFirstPartyCookies(await loadHandler())

    expect(first).toEqual(second)
  })

  it('accepts a cookie minted by another instance sharing the same secret', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('FIRST_PARTY_COOKIE_SECRET', 'stable-secret')
    const cookiesFromInstanceA = getFirstPartyCookies(await loadHandler())
    const handlerB = await loadHandler()
    const event = makeEvent('/api/internal/token-list', {}, 'GET', cookiesFromInstanceA)

    expect(handlerB(event)).toBeUndefined()
  })

  it('derives a stable first-party cookie value from the app URL when the secret is absent', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const first = getFirstPartyCookies(await loadHandler())
    const second = getFirstPartyCookies(await loadHandler())

    expect(first).toEqual(second)
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

  it('rejects loopback requests without a first-party cookie or internal marker', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/euler-chains', {}, 'GET', {}, '127.0.0.1'))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('allows same-process internal requests with the internal marker', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()
    // Import AFTER loadHandler's vi.resetModules() so the test reads the
    // same per-process marker instance the reloaded middleware verifies.
    const { getInternalFetchHeaders } = await import('~/server/utils/internal-headers')
    const internalEvent = makeEvent('/api/internal/vaults', { ...getInternalFetchHeaders() })

    expect(handler(internalEvent)).toBeUndefined()
    expect(internalEvent.headers['X-API-Stability']).toBe('internal; may-break-without-notice')
  })

  it('rejects a forged legacy loopback sentinel on no-Origin internal requests', async () => {
    // Reproduces the review finding: the sentinel used to satisfy the
    // internal-request exception below, letting header-forging clients
    // through the no-Origin rejection.
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    const handler = await loadHandler()

    try {
      handler(makeEvent('/api/internal/vaults', { 'cf-connecting-ip': '127.0.0.1' }))
      throw new Error('Expected internal API call to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        statusMessage: 'Forbidden',
      })
    }
  })

  it('derives x-country-code from the edge and strips the client-supplied value', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('EDGE_PROVIDER', 'cloudflare')
    const handler = await loadHandler()
    const event = makeEvent('/', { 'cf-ipcountry': 'DE', 'x-country-code': 'US' })

    expect(handler(event)).toBeUndefined()
    expect(event.headers['x-country-code']).toBe('DE')
    expect(event.node.req.headers['x-country-code']).toBeUndefined()
  })

  it('omits x-country-code when a geo-capable edge leaves the country undetermined in prod', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('EDGE_PROVIDER', 'cloudflare')
    vi.stubEnv('DEV_GEO_COUNTRY', '')
    const handler = await loadHandler()
    const event = makeEvent('/')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['x-country-code']).toBeUndefined()
  })

  it('sends the "--" placeholder under the none preset so clients do not fail closed', async () => {
    vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
    vi.stubEnv('DEV_GEO_COUNTRY', '')
    const handler = await loadHandler()
    const event = makeEvent('/')

    expect(handler(event)).toBeUndefined()
    expect(event.headers['x-country-code']).toBe('--')
  })
})
