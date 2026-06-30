import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildEulerSDK: vi.fn(),
  resolveRpcUrl: vi.fn(),
  resolveLabelsBaseUrl: vi.fn(),
}))

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  buildEulerSDK: mocks.buildEulerSDK,
}))

vi.mock('~/server/utils/rpc', () => ({
  resolveRpcUrl: mocks.resolveRpcUrl,
}))

vi.mock('~/server/utils/labels-base-url', () => ({
  resolveLabelsBaseUrl: mocks.resolveLabelsBaseUrl,
}))

describe('getServerSdk', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.buildEulerSDK.mockReset()
    mocks.resolveRpcUrl.mockReset()
    mocks.resolveLabelsBaseUrl.mockReset()
    mocks.buildEulerSDK.mockImplementation(async options => ({ options }))
    mocks.resolveRpcUrl.mockReturnValue('https://rpc.example')
    mocks.resolveLabelsBaseUrl.mockReturnValue('https://labels.example')
    process.env.V3_API_URL = 'https://v3.example'
    process.env.SERVER_VAULT_CACHE_SOURCE = 'fallback'
    process.env.DEPRECATED_CHAINS = '8453'
  })

  it('forces deprecated chains to onchain while regular chains use the configured source', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)
    await getServerSdk(8453)

    expect(mocks.buildEulerSDK).toHaveBeenCalledTimes(2)
    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].config).toMatchObject({
      accountServiceAdapter: 'fallback',
      eVaultServiceAdapter: 'fallback',
      eulerEarnServiceAdapter: 'fallback',
      rewardsServiceAdapter: 'fallback',
    })
    expect(mocks.buildEulerSDK.mock.calls[1]?.[0].config).toMatchObject({
      accountServiceAdapter: 'onchain',
      eVaultServiceAdapter: 'onchain',
      eulerEarnServiceAdapter: 'onchain',
      rewardsServiceAdapter: 'direct',
    })
  })
})
