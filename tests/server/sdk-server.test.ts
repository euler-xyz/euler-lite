import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildEulerSDK: vi.fn(),
  resolveRpcUrl: vi.fn(),
}))

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  buildEulerSDK: mocks.buildEulerSDK,
}))

vi.mock('~/server/utils/rpc', () => ({
  resolveRpcUrl: mocks.resolveRpcUrl,
}))

describe('getServerSdk', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.buildEulerSDK.mockReset()
    mocks.resolveRpcUrl.mockReset()
    mocks.buildEulerSDK.mockImplementation(async options => ({ options }))
    mocks.resolveRpcUrl.mockReturnValue('https://rpc.example')
    process.env.V3_API_URL = 'https://v3.example'
    process.env.SERVER_VAULT_CACHE_SOURCE = 'fallback'
    // Routing is driven by ONCHAIN_SDK_CHAINS only; DEPRECATED_CHAINS is a
    // UI/warm-cache concern and must not affect adapter selection.
    process.env.DEPRECATED_CHAINS = '1'
    process.env.ONCHAIN_SDK_CHAINS = '8453'
    delete process.env.TURTLE_EARN_API_KEY
  })

  it('forces ONCHAIN_SDK_CHAINS chains to onchain while other chains use the configured source', async () => {
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

  it('hands the server-only Turtle key and fixed upstream to the rewards adapters', async () => {
    process.env.TURTLE_EARN_API_KEY = ' turtle-secret '
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    const config = mocks.buildEulerSDK.mock.calls[0]?.[0].config
    expect(config).toMatchObject({
      rewardsTurtleApiKey: 'turtle-secret',
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v1',
    })
    expect(config).not.toHaveProperty('rewardsEnableTurtle')
  })

  it('disables Turtle discovery without a key instead of sending unauthenticated requests', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    const config = mocks.buildEulerSDK.mock.calls[0]?.[0].config
    expect(config).toMatchObject({ rewardsEnableTurtle: false })
    expect(config).not.toHaveProperty('rewardsTurtleApiKey')
    expect(config).not.toHaveProperty('rewardsTurtleApiUrl')
  })

  it('ignores upstream URL variables so the key only travels to the fixed Turtle host', async () => {
    process.env.TURTLE_EARN_API_KEY = 'turtle-secret'
    process.env.TURTLE_EARN_API_URL = 'https://evil.example/v1'
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].config).toMatchObject({
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v1',
    })
    delete process.env.TURTLE_EARN_API_URL
  })
})
