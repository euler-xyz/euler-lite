import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string | string[]>,
  cacheControl: undefined as string | undefined,
  getPublicLabelsBundle: vi.fn(),
  refreshPublicLabelsBundle: vi.fn(),
  getCachedPublicLabelsBundle: vi.fn(),
  consume: vi.fn(),
  setResponseHeader: vi.fn(),
  internal: true,
  rpcUrl: 'http://rpc.local' as string | undefined,
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
  getCachedPublicLabelsBundle: mocks.getCachedPublicLabelsBundle,
}))

vi.mock('~/server/utils/internal-headers', () => ({ isInternalRequest: () => mocks.internal }))
vi.mock('~/server/utils/rpc', () => ({ resolveRpcUrl: () => mocks.rpcUrl }))

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
    mocks.getCachedPublicLabelsBundle.mockReset().mockReturnValue(undefined)
    mocks.internal = true
    mocks.rpcUrl = 'http://rpc.local'
    mocks.consume.mockReset()
    mocks.setResponseHeader.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('leaves an omitted version to the server deployment default', async () => {
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ source: 'cache' })
    expect(mocks.getPublicLabelsBundle).toHaveBeenCalledWith(1, undefined)
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
  })
  it.each(['cached', 'fetch'] as const)('returns actionable configuration details for a %s failure without caching the error', async (stage) => {
    const handler = await loadHandler()
    const { LabelsConfigurationError } = await import('~/server/utils/labels-configuration-error')
    const message = 'STATIC_LABELS_BASE_URL is required for static labels'
    const error = new LabelsConfigurationError(message)
    if (stage === 'cached') mocks.getCachedPublicLabelsBundle.mockImplementation(() => {
      throw error
    })
    else mocks.getPublicLabelsBundle.mockRejectedValue(error)
    await expect(handler({})).rejects.toMatchObject({
      statusCode: 503, data: { code: 'LABELS_CONFIGURATION_ERROR', message },
    })
    expect(mocks.setResponseHeader).toHaveBeenLastCalledWith({}, 'Cache-Control', 'no-store')
  })

  it('forces the selected deterministic version on no-cache requests', async () => {
    mocks.query = { chainId: '1', version: 'v20260804151305236' }
    mocks.cacheControl = 'no-cache'
    const handler = await loadHandler()

    await expect(handler({})).resolves.toEqual({ source: 'refresh' })
    expect(mocks.refreshPublicLabelsBundle).toHaveBeenCalledWith(1, 'v20260804151305236')
  })

  it('passes a named published version through to the selected server source', async () => {
    mocks.query = { chainId: '1', version: 'test-2026-06-30' }
    const handler = await loadHandler()
    await handler({})
    expect(mocks.getPublicLabelsBundle).toHaveBeenCalledWith(1, 'test-2026-06-30')
  })

  it('rejects a chain this deployment does not serve', async () => {
    mocks.rpcUrl = undefined
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Unsupported chainId' })
    expect(mocks.getPublicLabelsBundle).not.toHaveBeenCalled()
  })

  it('keeps named versions for internal callers', async () => {
    mocks.internal = false
    mocks.query = { chainId: '1', version: 'test-2026-06-30' }
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.getPublicLabelsBundle).not.toHaveBeenCalled()
  })

  it('serves a bundle refreshed within the last thirty seconds instead of forcing another upstream read', async () => {
    mocks.cacheControl = 'no-cache'
    mocks.getCachedPublicLabelsBundle.mockReturnValue({ source: 'v3', sourceFetchedAt: Date.now() - 5_000 })
    const handler = await loadHandler()
    await expect(handler({})).resolves.toEqual({ source: 'cache' })
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
    mocks.getCachedPublicLabelsBundle.mockReturnValue({ source: 'v3', sourceFetchedAt: Date.now() - 60_000 })
    await expect(handler({})).resolves.toEqual({ source: 'refresh' })
  })

  it('rejects unsupported version shapes before fetching', async () => {
    mocks.query = { chainId: '1', version: 'draft' }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.getPublicLabelsBundle).not.toHaveBeenCalled()
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
  })

  it.each([
    ['repeated', ['v20260804151305236', 'draft']],
    ['empty', ''],
  ])('rejects %s version parameters instead of serving the default bundle', async (_, version) => {
    mocks.query = { chainId: '1', version }
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Invalid labels version' })
    expect(mocks.getPublicLabelsBundle).not.toHaveBeenCalled()
    expect(mocks.refreshPublicLabelsBundle).not.toHaveBeenCalled()
  })
})
