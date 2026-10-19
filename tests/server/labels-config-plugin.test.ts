import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ loadEulerChains: vi.fn(), error: vi.fn() }))
vi.mock('~/server/api/internal/euler-chains.get', () => ({ loadEulerChains: mocks.loadEulerChains }))
vi.mock('~/server/utils/logger', () => ({ logger: { error: mocks.error } }))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('LABELS_SOURCE', 'v3')
  vi.stubEnv('DISABLE_V3', '')
  vi.stubEnv('LABELS_IMAGE_ORIGINS', '')
  vi.stubEnv('DEPRECATED_CHAINS', '')
  vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
  vi.stubEnv('RPC_URL_146', 'https://rpc.example')
  mocks.error.mockReset()
  mocks.loadEulerChains.mockReset().mockResolvedValue([{ chainId: 146, status: 'deprecated' }])
})
afterEach(() => vi.unstubAllEnvs())

it('reports missing static configuration at boot without preventing the server from starting', async () => {
  vi.stubEnv('LABELS_SOURCE', 'static')
  vi.stubEnv('STATIC_LABELS_BASE_URL', '')
  const { default: plugin } = await import('~/server/plugins/labels-config')
  expect(() => plugin({} as never)).not.toThrow()
  expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'STATIC_LABELS_BASE_URL is required for static labels' }), expect.any(String))
  expect(mocks.loadEulerChains).not.toHaveBeenCalled()
})

it('checks registry-derived deprecation when the manifest arrives', async () => {
  const { default: plugin } = await import('~/server/plugins/labels-config')
  plugin({} as never)
  await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('ONCHAIN_SDK_CHAINS: 146') }), expect.any(String)))
})

it('accepts the hosted setup with the on-chain chain entry', async () => {
  vi.stubEnv('ONCHAIN_SDK_CHAINS', '146')
  const { default: plugin } = await import('~/server/plugins/labels-config')
  plugin({} as never)
  await mocks.loadEulerChains.mock.results[0]!.value
  expect(mocks.error).not.toHaveBeenCalled()
})

it.each(['missing', 'unlisted', 'staging'])('does not diagnose a %s chain excluded from this deployment', async (status) => {
  vi.stubEnv('DEPRECATED_CHAINS', '146')
  vi.stubEnv('DOPPLER_ENVIRONMENT', 'prd')
  mocks.loadEulerChains.mockResolvedValue(status === 'missing'
    ? [{ chainId: 1, status: 'production' }]
    : [{ chainId: 146, status }])
  const { default: plugin } = await import('~/server/plugins/labels-config')
  plugin({} as never)
  expect(mocks.loadEulerChains).toHaveBeenCalledOnce()
  await mocks.loadEulerChains.mock.results[0]!.value
  expect(mocks.error).not.toHaveBeenCalled()
})
