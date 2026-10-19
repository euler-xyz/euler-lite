import { afterEach, expect, it, vi } from 'vitest'
import { PriceService, PricingBackendClient, TokenlistService, type DeploymentService, type ProviderService } from '@eulerxyz/euler-v2-sdk'
import { createNoV3IntrinsicApyService, disableSdkV3Utilities } from '~/utils/sdk-no-v3'

afterEach(() => vi.unstubAllGlobals())

it('keeps on-chain prices and verified token decimals without making V3 utility requests', async () => {
  const fetch = vi.fn(() => {
    throw new Error('Unexpected HTTP request')
  })
  vi.stubGlobal('fetch', fetch)
  const asset = '0x0000000000000000000000000000000000000001'
  const readContract = vi.fn().mockImplementation(async ({ functionName }) =>
    functionName === 'decimals' ? 6 : { queryFailure: false, amountOutMid: 2n * 10n ** 18n })
  const provider = { getProvider: () => ({ readContract }) } as unknown as ProviderService
  const deployments = { getDeployment: () => ({ addresses: { lensAddrs: { utilsLens: asset } } }) } as unknown as DeploymentService
  const priceService = new PriceService(provider, deployments, new PricingBackendClient({ endpoint: 'https://v3.example' }))
  const tokenlistService = new TokenlistService({ getTokenListUrl: () => 'https://v3.example/v3/tokens' }, undefined, provider)
  disableSdkV3Utilities({ priceService, tokenlistService })
  expect(await priceService.fetchAssetUsdPriceByAddress(1, asset)).toBe(2)
  expect(await tokenlistService.loadTokenlist(1)).toEqual([])
  expect(await tokenlistService.resolveTokenDecimals(1, asset)).toBe(6)
  expect(await createNoV3IntrinsicApyService().fetchIntrinsicApy(1, asset)).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
