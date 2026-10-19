import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLiquidationCoverage: vi.fn(),
  resolveChainId: vi.fn(),
  consume: vi.fn(),
  setResponseHeader: vi.fn(),
}))

vi.mock('h3', () => ({ setResponseHeader: mocks.setResponseHeader }))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: mocks.consume }) }))
vi.mock('~/server/utils/resolve-chain-id', () => ({ resolveChainId: mocks.resolveChainId }))
vi.mock('~/server/utils/liquidation-coverage-source', () => ({
  getLiquidationCoverage: mocks.getLiquidationCoverage,
}))

const loadHandler = async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  const route = await import('~/server/api/internal/liquidation-coverage.get')
  return route.default as (event: unknown) => Promise<unknown>
}

describe('liquidation coverage endpoint', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.resolveChainId.mockReset().mockReturnValue(8453)
    mocks.getLiquidationCoverage.mockReset().mockResolvedValue({ enabled: true, chainId: 8453, state: 'no-bot' })
    mocks.consume.mockReset()
    mocks.setResponseHeader.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('answers the enabled chain\'s coverage with a short public cache', async () => {
    const handler = await loadHandler()
    const event = {}

    await expect(handler(event)).resolves.toEqual({ enabled: true, chainId: 8453, state: 'no-bot' })
    expect(mocks.consume).toHaveBeenCalledWith(event)
    expect(mocks.resolveChainId).toHaveBeenCalledWith(event, { requireEnabled: true })
    expect(mocks.getLiquidationCoverage).toHaveBeenCalledWith(8453)
    expect(mocks.setResponseHeader).toHaveBeenCalledWith(
      event,
      'Cache-Control',
      'public, max-age=60, stale-while-revalidate=60',
    )
  })

  it('refuses a chain the deployment does not enable before asking any bot', async () => {
    mocks.resolveChainId.mockImplementation(() => {
      throw Object.assign(new Error('Unsupported chainId'), { statusCode: 400 })
    })
    const handler = await loadHandler()

    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.getLiquidationCoverage).not.toHaveBeenCalled()
  })
})
