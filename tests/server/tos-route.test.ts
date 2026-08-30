import { createApp, toWebHandler, type EventHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn },
}))

const TOS_URL = 'https://legal.example/terms.md'
const EXECUTABLE_LOOKING_TOS = '<script>globalThis.compromised = true</script>\n# Terms of Use\n'

const loadRouteFetch = async () => {
  vi.resetModules()
  const handler = (await import('~/server/api/internal/tos.get')).default as EventHandler
  const app = createApp()
  app.use('/api/internal/tos', handler)
  return toWebHandler(app)
}

const requestTos = async (routeFetch: ReturnType<typeof toWebHandler>) => {
  const response = await routeFetch(new Request('https://app.example/api/internal/tos'))

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; sandbox')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(await response.text()).toBe(EXECUTABLE_LOOKING_TOS)
}

describe('/api/internal/tos route', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'))
    vi.stubEnv('NUXT_PUBLIC_CONFIG_TOS_MD_URL', TOS_URL)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('serves a fresh upstream response as inert plain text', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response(EXECUTABLE_LOOKING_TOS))
    const routeFetch = await loadRouteFetch()

    await requestTos(routeFetch)

    expect(mocks.consume).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledOnce()
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(TOS_URL)
  })

  it('serves a cache hit with the same plain-text response contract', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response(EXECUTABLE_LOOKING_TOS))
    const routeFetch = await loadRouteFetch()

    await requestTos(routeFetch)
    await requestTos(routeFetch)

    expect(mocks.consume).toHaveBeenCalledTimes(2)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledOnce()
  })

  it('serves stale content with the same plain-text response contract after an upstream failure', async () => {
    mocks.fetchWithTimeout
      .mockResolvedValueOnce(new Response(EXECUTABLE_LOOKING_TOS))
      .mockRejectedValueOnce(new Error('upstream unavailable'))
    const routeFetch = await loadRouteFetch()

    await requestTos(routeFetch)
    vi.setSystemTime(new Date('2026-07-10T12:05:00.000Z'))
    await requestTos(routeFetch)

    expect(mocks.consume).toHaveBeenCalledTimes(2)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(mocks.warn).toHaveBeenCalledWith(
      { ctx: 'tos', err: expect.any(Error) },
      'upstream fetch failed',
    )
  })
})
