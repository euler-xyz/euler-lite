import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}))

const { createV3ImagesBaseSource, readV3ImagesBaseUrl, V3_IMAGES_REFRESH_MS, V3_IMAGES_RETRY_MS }
  = await import('~/server/utils/v3-images-base')

const BASE = 'https://v3.example/v3/images'
const env = { V3_API_URL: 'https://v3-internal.example/', EULER_SDK_V3_API_KEY: 'server-key' }
const answer = (publicBaseUrl: unknown, status = 200) =>
  new Response(JSON.stringify({ data: { publicBaseUrl } }), { status })

describe('readV3ImagesBaseUrl', () => {
  afterEach(() => {
    mocks.fetchWithTimeout.mockReset()
  })

  it('reads the public images base from its own V3 with the server key', async () => {
    mocks.fetchWithTimeout.mockResolvedValue(answer(BASE))

    await expect(readV3ImagesBaseUrl(env)).resolves.toEqual({ status: 'ok', baseUrl: BASE })
    const [url, , init] = mocks.fetchWithTimeout.mock.calls[0]
    expect(url).toBe('https://v3-internal.example/v3/images')
    expect(new Headers(init.headers).get('X-API-Key')).toBe('server-key')
  })

  it('reports an invalid answer', async () => {
    for (const response of [
      answer('http://v3.example/v3/images'),
      answer(null),
      new Response('not json'),
      answer(BASE, 404),
    ]) {
      mocks.fetchWithTimeout.mockResolvedValueOnce(response)
      await expect(readV3ImagesBaseUrl(env)).resolves.toEqual({ status: 'invalid' })
    }
  })

  it('reports an unreachable V3', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await expect(readV3ImagesBaseUrl(env)).resolves.toEqual({ status: 'unreachable' })

    mocks.fetchWithTimeout.mockResolvedValueOnce(answer(BASE, 503))
    await expect(readV3ImagesBaseUrl(env)).resolves.toEqual({ status: 'unreachable' })
  })
})

describe('createV3ImagesBaseSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.warn.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is empty until the boot read answers, then holds the base', async () => {
    const read = vi.fn().mockResolvedValue({ status: 'ok', baseUrl: BASE })
    const source = createV3ImagesBaseSource({ read })

    expect(source.get()).toBe('')
    await source.refresh()
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('refreshes hourly once it has a base', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
      .mockResolvedValueOnce({ status: 'ok', baseUrl: 'https://cdn.example/v3/images' })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()

    await vi.advanceTimersByTimeAsync(V3_IMAGES_REFRESH_MS - 1)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(source.get()).toBe('https://cdn.example/v3/images')
    source.stop()
  })

  it('stays empty and retries sooner when V3 is unreachable at boot', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'unreachable' })
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    expect(source.get()).toBe('')

    await vi.advanceTimersByTimeAsync(V3_IMAGES_RETRY_MS)
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('keeps the last good base through an unreachable refresh but clears it on an invalid answer', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
      .mockResolvedValueOnce({ status: 'unreachable' })
      .mockResolvedValueOnce({ status: 'invalid' })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    await source.refresh()
    expect(source.get()).toBe(BASE)
    await source.refresh()
    expect(source.get()).toBe('')
    source.stop()
  })

  it('retries sooner after an invalid answer clears the base', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
      .mockResolvedValueOnce({ status: 'invalid' })
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    await source.refresh()
    expect(source.get()).toBe('')

    await vi.advanceTimersByTimeAsync(V3_IMAGES_RETRY_MS)
    expect(read).toHaveBeenCalledTimes(3)
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('keeps the hourly cadence while it keeps the last good base', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
      .mockResolvedValue({ status: 'unreachable' })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    await source.refresh()

    await vi.advanceTimersByTimeAsync(V3_IMAGES_RETRY_MS)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(V3_IMAGES_REFRESH_MS - V3_IMAGES_RETRY_MS)
    expect(read).toHaveBeenCalledTimes(3)
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('treats a failing reader as unreachable and keeps refreshing', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'ok', baseUrl: BASE })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    expect(source.get()).toBe('')

    await vi.advanceTimersByTimeAsync(V3_IMAGES_RETRY_MS)
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('start returns the boot read so callers can wait for it', async () => {
    const read = vi.fn().mockResolvedValue({ status: 'ok', baseUrl: BASE })
    const source = createV3ImagesBaseSource({ read })

    await source.start()
    expect(source.get()).toBe(BASE)
    source.stop()
  })

  it('logs only when the state changes and stops refreshing when stopped', async () => {
    const read = vi.fn().mockResolvedValue({ status: 'invalid' })
    const source = createV3ImagesBaseSource({ read })
    await source.refresh()
    await source.refresh()
    expect(mocks.warn).toHaveBeenCalledTimes(1)

    source.stop()
    await vi.advanceTimersByTimeAsync(V3_IMAGES_REFRESH_MS * 2)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
