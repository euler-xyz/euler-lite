import type { H3Event } from 'h3'
import { createApp, createRouter, eventHandler, setResponseHeaders, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}))

const APP_ORIGIN = 'https://app.example'
const FOREIGN_ORIGIN = 'https://foreign.example'
const API_PREFIXES = ['/api', '/%61pi', '/a%70i', '/ap%69', '/%61%70%69']
const MIB = 1024 * 1024
const SIMULATION = {
  chainId: 1,
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  data: '0x',
  value: '0',
  stateOverrides: [],
}
const upstreamFetch = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('defineEventHandler', eventHandler)
  vi.stubGlobal('fetch', upstreamFetch)
  upstreamFetch.mockReset()
  upstreamFetch.mockImplementation(async (input) => {
    const url = String(input)
    const tenderlyBase = 'https://api.tenderly.co/api/v1/account/local-test/project/local-test'
    if (url === tenderlyBase + '/simulate') return Response.json({ simulation: { id: 'local-simulation' } })
    if (url === tenderlyBase + '/simulations/local-simulation/share') return Response.json({})
    if (url === 'https://api.merkl.xyz/v4/opportunities?chainId=1&type=EULER&campaigns=true') return Response.json([])
    throw new Error('Test prohibits unexpected upstream requests')
  })
  for (const [key, value] of Object.entries({
    DOPPLER_ENVIRONMENT: 'prd',
    EDGE_PROVIDER: 'cloudflare',
    EDGE_ORIGIN_SECRET: '',
    DEV_GEO_COUNTRY: '',
    DISABLE_RATE_LIMIT: 'false',
    NUXT_PUBLIC_APP_URL: APP_ORIGIN,
    CORS_ALLOWED_ORIGINS: APP_ORIGIN,
    FIRST_PARTY_COOKIE_SECRET: 'fake-cookie-secret',
    TENDERLY_ACCESS_KEY: 'fake-tenderly-key',
    TENDERLY_ACCOUNT_SLUG: 'local-test',
    TENDERLY_PROJECT_SLUG: 'local-test',
    MERKL_API_KEY: 'fake-merkl-key',
    DISABLE_V3: 'false',
  })) {
    vi.stubEnv(key, value)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type TestRequestInit = RequestInit & { origin?: string | null, country?: string | null }

// Real h3 dispatch preserves originalUrl while decoding event.path, as Nitro does.
async function createHarness() {
  const [bodyLimit, cors, geoGate, sensitiveCache, status, simulate, merkl, v3] = await Promise.all([
    import('~/server/middleware/body-limit'),
    import('~/server/middleware/cors'),
    import('~/server/middleware/geo-gate'),
    import('~/server/plugins/sensitive-route-cache'),
    import('~/server/api/internal/tenderly/status.get'),
    import('~/server/api/internal/tenderly/simulate.post'),
    import('~/server/api/internal/proxy/merkl/[...path]'),
    import('~/server/api/internal/v3/[...path]'),
  ])
  const app = createApp({ onBeforeResponse: sensitiveCache.forceNoStoreForSensitivePath })
  for (const middleware of [bodyLimit.default, cors.default, geoGate.default]) app.use(middleware)
  const router = createRouter()
  router.get('/', eventHandler(() => 'app'))
  router.get('/api/public/status', eventHandler(() => ({ ok: true })))
  router.get('/api/internal/tenderly/status', status.default)
  router.post('/api/internal/tenderly/simulate', simulate.default)
  router.post('/api/internal/rpc/:chainId', eventHandler(() => ({ ok: true })))
  router.post('/api/internal/screen-address', eventHandler((event: H3Event) => {
    setResponseHeaders(event, {
      'cache-control': 'public, max-age=60',
      'cdn-cache-control': 'public, max-age=60',
      'cloudflare-cdn-cache-control': 'public, max-age=60',
    })
    return { ok: true }
  }))
  router.use('/api/internal/proxy/merkl/**', merkl.default)
  router.use('/api/internal/v3/**', v3.default)
  app.use(router.handler)
  const handle = toWebHandler(app)

  return (path: string, { origin = APP_ORIGIN, country = 'GB', ...init }: TestRequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('cf-connecting-ip', '198.51.100.10')
    if (origin !== null) headers.set('origin', origin)
    if (country !== null) headers.set('cf-ipcountry', country)
    return handle(new Request(APP_ORIGIN + path, { ...init, headers }))
  }
}

// An empty Blob MIME type exercises the browser's no-preflight JSON POST shape.
function jsonPost(body: unknown): RequestInit {
  const json = JSON.stringify(body)
  return {
    method: 'POST',
    headers: { 'content-length': String(Buffer.byteLength(json)) },
    body: new Blob([json], { type: '' }),
  }
}

describe('API guards through the h3 router', () => {
  it.each(API_PREFIXES)('rejects foreign origins for %s', async (prefix) => {
    const request = await createHarness()
    const response = await request(prefix + '/internal/tenderly/status', { origin: FOREIGN_ORIGIN })
    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each(API_PREFIXES)('rejects unmarked no-Origin requests for %s', async (prefix) => {
    const request = await createHarness()
    const response = await request(prefix + '/internal/tenderly/status', { origin: null })
    expect(response.status).toBe(403)
  })

  it.each(API_PREFIXES)('blocks sanctioned and undetermined countries for %s', async (prefix) => {
    const request = await createHarness()
    for (const country of ['KP', 'T1', null]) {
      const response = await request(prefix + '/internal/tenderly/status', { country })
      expect(response.status, 'country=' + country).toBe(451)
    }
  })

  it.each(API_PREFIXES)('allows configured origins and enforces no-store for %s', async (prefix) => {
    const request = await createHarness()
    const response = await request(prefix + '/internal/tenderly/status?check=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: true })
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it.each(API_PREFIXES)('blocks simple cross-origin Tenderly POSTs before upstream calls for %s', async (prefix) => {
    const request = await createHarness()
    const response = await request(prefix + '/internal/tenderly/simulate', {
      ...jsonPost(SIMULATION),
      origin: FOREIGN_ORIGIN,
    })
    expect(response.status).toBe(403)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it.each(API_PREFIXES)('enforces RPC body limits and required length for %s', async (prefix) => {
    const request = await createHarness()
    const oversized = await request(prefix + '/internal/rpc/1', jsonPost({ padding: 'x'.repeat(MIB) }))
    expect(oversized.status).toBe(413)
    const missingLength = await request(prefix + '/internal/rpc/1', { ...jsonPost({}), headers: {} })
    expect(missingLength.status).toBe(411)
  })

  it('applies the Tenderly-specific 2 MiB limit to encoded route segments', async () => {
    const request = await createHarness()
    const path = '/%61pi/%69nternal/%74enderly/simulate'
    const oversized = await request(path, jsonPost({ ...SIMULATION, padding: 'x'.repeat(2 * MIB) }))
    expect(oversized.status).toBe(413)
    expect(upstreamFetch).not.toHaveBeenCalled()

    const allowed = await request(path, jsonPost({ ...SIMULATION, padding: 'x'.repeat(MIB) }))
    expect(allowed.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledTimes(2)
    expect(upstreamFetch.mock.calls[0][1]?.headers).toMatchObject({ 'X-Access-Key': 'fake-tenderly-key' })
  })

  it('allows marked no-Origin requests on encoded API paths', async () => {
    const request = await createHarness()
    const shell = await request('/', { origin: null })
    const cookie = shell.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const response = await request('/%61pi/internal/tenderly/status', { origin: null, headers: { cookie: cookie! } })
    expect(response.status).toBe(200)
  })

  it('preserves the authenticated server-internal exemption on encoded API paths', async () => {
    const request = await createHarness()
    const { getInternalFetchHeaders } = await import('~/server/utils/internal-headers')
    const response = await request('/%61pi/internal/tenderly/status', {
      origin: null,
      country: null,
      headers: getInternalFetchHeaders(),
    })
    expect(response.status).toBe(200)
  })

  it('classifies encoded public routes and preflights using the routed path', async () => {
    const request = await createHarness()
    for (const method of ['GET', 'OPTIONS']) {
      const response = await request('/%61pi/%70ublic/status?check=1', { method, origin: FOREIGN_ORIGIN })
      expect(response.status).toBe(method === 'OPTIONS' ? 204 : 200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    }
    const rejected = await request('/%61pi/%69nternal/tenderly/status', { method: 'OPTIONS', origin: FOREIGN_ORIGIN })
    expect(rejected.status).toBe(403)
    const allowed = await request('/%61pi/%69nternal/tenderly/status', { method: 'OPTIONS' })
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
  })

  it('keeps the sibling-origin exception scoped to the routed screening endpoint', async () => {
    const request = await createHarness()
    const origin = 'https://create.euler.finance'
    const allowed = await request('/%61pi/%69nternal/%73creen-address?check=1', { ...jsonPost({}), origin })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin)
    const rejected = await request('/%61pi/internal/tenderly/simulate', { ...jsonPost(SIMULATION), origin })
    expect(rejected.status).toBe(403)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('overrides cacheable headers on an encoded sensitive path with a trailing slash and query', async () => {
    const request = await createHarness()
    const response = await request('/%61pi/%69nternal/%73creen-address/?check=1', jsonPost({}))
    expect(response.status).toBe(200)
    for (const name of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) {
      expect(response.headers.get(name), name).toBe('no-store')
    }
  })

  it('rejects a nested provider prefix before attaching credentials or contacting upstream', async () => {
    const request = await createHarness()
    const response = await request('/%61pi/internal/proxy/merkl/api/internal/proxy/merkl/opportunities?chainId=1&type=EULER&campaigns=true')
    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it.each(['/api/internal/v3/labels/%31', '/%61pi/internal/v3/labels/1'])('preserves V3 raw-path rejection for %s', async (path) => {
    const request = await createHarness()
    const response = await request(path)
    expect(response.status).toBe(400)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it.each(['/api%2Finternal/tenderly/status', '/%2561pi/internal/tenderly/status'])('does not decode a second time for %s', async (path) => {
    const request = await createHarness()
    const response = await request(path)
    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
