import type { VaultFetchOptions } from '@eulerxyz/euler-v2-sdk'

export const liteVaultFetchOptions = {
  populateMarketPrices: true,
  populateCollaterals: true,
  populateStrategyVaults: true,
  populateRewards: true,
  populateIntrinsicApy: true,
  eVaultFetchOptions: {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateRewards: true,
    populateIntrinsicApy: true,
  },
} satisfies VaultFetchOptions

export const liteSecuritizeVaultFetchOptions = {
  populateMarketPrices: true,
  populateRewards: true,
  populateIntrinsicApy: true,
} satisfies VaultFetchOptions
