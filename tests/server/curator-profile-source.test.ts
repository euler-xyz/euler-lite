import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }))

vi.mock('~/server/utils/fetchWithTimeout', async importOriginal => ({
  ...await importOriginal<typeof import('~/server/utils/fetchWithTimeout')>(),
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

describe('curator profile source', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('LABELS_V3_SET', 'public')
    vi.stubEnv('LABELS_V3_VERSION', 'v20260929000000000')
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    mocks.fetchWithTimeout.mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('loads one published entity without a chain parameter and caches it across network views', async () => {
    mocks.fetchWithTimeout.mockResolvedValue(Response.json({ data: {
      id: 'k3-capital',
      name: 'K3 Capital',
      description: 'Global profile',
      url: 'https://k3.capital',
    } }))
    const { getCuratorProfile } = await import('~/server/utils/curator-profile-source')

    const first = await getCuratorProfile('k3-capital')
    expect(await getCuratorProfile('k3-capital')).toBe(first)
    expect(first).toMatchObject({ source: 'v3', entity: { id: 'k3-capital', name: 'K3 Capital' } })
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    const url = new URL(mocks.fetchWithTimeout.mock.calls[0][0])
    expect(url.pathname).toBe('/v3/labels/entities/k3-capital')
    expect(url.searchParams.get('version')).toBe('v20260929000000000')
    expect(url.searchParams.has('chainId')).toBe(false)
  })

  it('distinguishes a missing entity from an unavailable V3 response', async () => {
    mocks.fetchWithTimeout.mockImplementation(async (input: string) =>
      new Response('', { status: input.includes('/missing') ? 404 : 503 }),
    )
    const { getCuratorProfile } = await import('~/server/utils/curator-profile-source')

    await expect(getCuratorProfile('missing')).resolves.toEqual({ source: 'v3', entity: null })
    await expect(getCuratorProfile('unavailable')).rejects.toThrow('503')
  })

  it('uses the chain labels profile in static mode without requesting V3', async () => {
    vi.stubEnv('LABELS_SOURCE', 'static')
    const { getCuratorProfile } = await import('~/server/utils/curator-profile-source')

    await expect(getCuratorProfile('k3-capital')).resolves.toEqual({ source: 'static', entity: null })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })
})
