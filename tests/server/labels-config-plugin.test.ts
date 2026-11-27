import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ error: vi.fn() }))
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
})
afterEach(() => vi.unstubAllEnvs())

it('reports missing static configuration at boot without preventing the server from starting', async () => {
  vi.stubEnv('LABELS_SOURCE', 'static')
  vi.stubEnv('STATIC_LABELS_BASE_URL', '')
  const { default: plugin } = await import('~/server/plugins/labels-config')
  expect(() => plugin({} as never)).not.toThrow()
  expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'STATIC_LABELS_BASE_URL is required for static labels' }), expect.any(String))
})

it('accepts hosted deprecation without a duplicated SDK override', async () => {
  vi.stubEnv('DEPRECATED_CHAINS', '146')
  const { default: plugin } = await import('~/server/plugins/labels-config')
  plugin({} as never)
  expect(mocks.error).not.toHaveBeenCalled()
})

it('accepts the hosted setup with the on-chain chain entry', async () => {
  vi.stubEnv('ONCHAIN_SDK_CHAINS', '146')
  const { default: plugin } = await import('~/server/plugins/labels-config')
  plugin({} as never)
  expect(mocks.error).not.toHaveBeenCalled()
})
