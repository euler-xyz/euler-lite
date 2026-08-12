import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  cacheControl: undefined as string | undefined,
  getPublicLabelsBundle: vi.fn(),
  refreshPublicLabelsBundle: vi.fn(),
  consume: vi.fn(),
  setResponseHeader: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (args: { statusCode: number, statusMessage: string }) => Object.assign(
    new Error(args.statusMessage),
    args,
  ),
  getHeader: () => mocks.cacheControl,
  getQuery: () => mocks.query,
  setResponseHeader: mocks.setResponseHeader,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/public-labels-source', () => ({
  getPublicLabelsBundle: mocks.getPublicLabelsBundle,
  refreshPublicLabelsBundle: mocks.refreshPublicLabelsBundle,
}))

const loadHandler = async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  const route = await import('~/server/api/internal/public-labels.get')
  return route.default as (event: unknown) => Promise<unknown>
}

describe('public labels aggregate endpoint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    mocks.query = { chainId: '1' }
    mocks.cacheControl = undefined
    mocks.getPublicLabelsBundle.mockReset().mockResolvedValue({ source: 'cache' })
    mocks.refreshPublicLabelsBundle.mockReset().mockResolvedValue({ source: 'refresh' })
    mocks.consume.mockReset()
    mocks.setResponseHeader.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the cached latest bundle for a normal request', async () => {
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ source: 'cache' })
    expect(mocks.getPublicLabelsBundle).toHaveBeenCalledWith(1, 'latest')
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
  })

  it('forces the selected deterministic version on no-cache requests', async () => {
    mocks.query = { chainId: '1', version: 'v20260804151305236' }
    mocks.cacheControl = 'no-cache'
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ source: 'refresh' })
    expect(mocks.refreshPublicLabelsBundle).toHaveBeenCalledWith(1, 'v20260804151305236')
  })

  it('rejects unsupported version shapes before fetching', async () => {
    mocks.query = { chainId: '1', version: 'draft' }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.getPublicLabelsBundle).not.toHaveBeenCalled()
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
  })
})
