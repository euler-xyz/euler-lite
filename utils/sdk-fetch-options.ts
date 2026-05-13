import type { VaultFetchOptions } from '@eulerxyz/euler-v2-sdk'

export const liteVaultFetchOptions = {
  populateMarketPrices: true,
  populateCollaterals: true,
  populateStrategyVaults: true,
  populateRewards: true,
  eVaultFetchOptions: {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateRewards: true,
  },
} satisfies VaultFetchOptions

export const liteSecuritizeVaultFetchOptions = {
  populateMarketPrices: true,
  populateRewards: true,
} satisfies VaultFetchOptions
