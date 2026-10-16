import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  getVerifiedAddressSnapshot: vi.fn(),
  setResponseHeader: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (args: { statusCode: number, statusMessage: string }) => Object.assign(new Error(args.statusMessage), args),
  getQuery: () => mocks.query,
  setResponseHeader: mocks.setResponseHeader,
}))

vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/rpc', () => ({ resolveRpcUrl: () => 'http://rpc.local' }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('~/server/utils/verified-vaults', async importOriginal => ({
  ...await importOriginal<typeof import('~/server/utils/verified-vaults')>(),
  getVerifiedAddressSnapshot: mocks.getVerifiedAddressSnapshot,
}))

const loadHandler = async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  const route = await import('~/server/api/public/is-known.get')
  return route.default as (event: unknown) => Promise<unknown>
}

describe('public is-known availability', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.query = { chainId: '1' }
    mocks.getVerifiedAddressSnapshot.mockReset()
    mocks.setResponseHeader.mockReset()
  })

  it('answers 503 with Retry-After when the last V3 read is older than a day', async () => {
    const { VerificationUnavailableError } = await import('~/server/utils/verified-vaults')
    mocks.getVerifiedAddressSnapshot.mockRejectedValue(new VerificationUnavailableError())
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Vault verification unavailable' })
    expect(mocks.setResponseHeader).toHaveBeenCalledWith({}, 'Retry-After', 60)
  })

  it('answers 502 for any other upstream failure', async () => {
    mocks.getVerifiedAddressSnapshot.mockRejectedValue(new Error('upstream down'))
    const handler = await loadHandler()
    await expect(handler({})).rejects.toMatchObject({ statusCode: 502 })
    expect(mocks.setResponseHeader).not.toHaveBeenCalledWith({}, 'Retry-After', 60)
  })
})
