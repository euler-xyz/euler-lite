import { describe, expect, it } from 'vitest'
import type { PublicProductLabel, PublicVaultLabel } from '@eulerxyz/euler-v2-sdk/public-labels'
import { summarizeManagerNetworks } from '~/server/utils/manager-network-index'

describe('summarizeManagerNetworks', () => {
  it('counts only owned products and Earn vaults on enabled chains', () => {
    const products = [
      { chainId: 1, entityId: 'k3-capital' },
      { chainId: 56, entityId: 'other', coBrandEntityIds: ['k3-capital'] },
      { chainId: 42161, entityId: 'k3-capital' },
      { chainId: 99999, entityId: 'k3-capital' },
    ] as PublicProductLabel[]
    const vaults = [
      { chainId: 1, entityId: 'k3-capital', vaultType: 'earn' },
      { chainId: 56, entityId: 'k3-capital', vaultType: 'evk' },
      { chainId: 56, entityId: 'other', vaultType: 'earn' },
      { chainId: 143, entityId: 'k3-capital', vaultType: 'earn' },
      { chainId: 99999, entityId: 'k3-capital', vaultType: 'earn' },
    ] as PublicVaultLabel[]

    expect(summarizeManagerNetworks('k3-capital', [1, 56, 143, 42161], products, vaults)).toEqual([
      { chainId: 1, productCount: 1, earnVaultCount: 1 },
      { chainId: 143, productCount: 0, earnVaultCount: 1 },
      { chainId: 42161, productCount: 1, earnVaultCount: 0 },
    ])
  })
})
