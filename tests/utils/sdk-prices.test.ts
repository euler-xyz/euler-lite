import { describe, expect, it } from 'vitest'
import {
  ONE_18,
  conservativePriceRatio,
  formatAssetValue,
  getAssetUsdPrice,
  getAssetUsdValue,
  getAssetUsdValueForEstimate,
  getCollateralUsdPrice,
  getCollateralUsdValue,
  toUsdAmount,
} from '~/utils/sdk-prices'
import { USD_ADDRESS } from '~/entities/constants'

const addressA = '0x1111111111111111111111111111111111111111'
const addressB = '0x2222222222222222222222222222222222222222'

describe('sdk-prices', () => {
  it('uses the vault marketPriceUsd field for off-chain asset pricing', async () => {
    const vault = {
      address: addressA,
      asset: { decimals: 6, symbol: 'USDC' },
      marketPriceUsd: 2n * ONE_18,
    }

    await expect(getAssetUsdPrice(vault, 'off-chain')).resolves.toMatchObject({
      amountOutMid: 2n * ONE_18,
      amountOutAsk: 2n * ONE_18,
      amountOutBid: 2n * ONE_18,
    })
    await expect(getAssetUsdValue(1_500_000n, vault, 'off-chain')).resolves.toBe(3)
  })

  it('preserves the normalized uncovered-loss amount when formatting it for display', async () => {
    const vault = {
      address: addressA,
      asset: { decimals: 6, symbol: 'USDT' },
      marketPriceUsd: ONE_18,
    }

    await expect(formatAssetValue(6_361_518_648_400n, vault, 'off-chain')).resolves.toMatchObject({
      assetAmount: 6_361_518.6484,
      usdValue: 6_361_518.6484,
      hasPrice: true,
      assetSymbol: 'USDT',
    })
  })

  it('distinguishes an empty estimate leg from a positive unpriced amount', async () => {
    const vault = {
      address: addressA,
      asset: { decimals: 6, symbol: 'USDC' },
    }

    await expect(getAssetUsdValueForEstimate(0n, vault, 'off-chain')).resolves.toBe(0)
    await expect(getAssetUsdValueForEstimate(1_000_000n, vault, 'off-chain')).resolves.toBeUndefined()
  })

  it('rejects a zero USD price for a positive estimate amount', async () => {
    const vault = {
      address: addressA,
      asset: { decimals: 6, symbol: 'USDC' },
      marketPriceUsd: 0n,
    }

    await expect(getAssetUsdValueForEstimate(0n, vault, 'off-chain')).resolves.toBe(0)
    await expect(getAssetUsdValueForEstimate(1_000_000n, vault, 'off-chain')).resolves.toBeUndefined()
  })

  it('uses the liability vault collateral edge marketPriceUsd for collateral values', async () => {
    const liabilityVault = {
      collaterals: [
        {
          address: addressB,
          marketPriceUsd: 3n * ONE_18,
        },
      ],
    }
    const collateralVault = {
      address: addressB,
      asset: { decimals: 18, symbol: 'COLL' },
    }

    await expect(getCollateralUsdPrice(liabilityVault, collateralVault, 'off-chain')).resolves.toMatchObject({
      amountOutMid: 3n * ONE_18,
      amountOutAsk: 3n * ONE_18,
      amountOutBid: 3n * ONE_18,
    })
    await expect(getCollateralUsdValue(2n * ONE_18, liabilityVault, collateralVault, 'off-chain')).resolves.toBe(6)
  })

  it('converts SDK risk prices to USD for on-chain price display', async () => {
    const vault = {
      type: 'EVault',
      address: addressA,
      unitOfAccount: { address: USD_ADDRESS },
      asset: { decimals: 18, symbol: 'DEBT' },
      assetRiskPrice: {
        priceLiquidation: 4n * ONE_18,
        priceBorrowing: 5n * ONE_18,
      },
    }

    await expect(getAssetUsdPrice(vault, 'on-chain')).resolves.toMatchObject({
      amountOutMid: 4n * ONE_18,
      amountOutAsk: 5n * ONE_18,
      amountOutBid: 4n * ONE_18,
    })
  })

  it('keeps conservative ratios on collateral bid versus liability ask', () => {
    expect(conservativePriceRatio(
      { amountOutMid: 4n * ONE_18, amountOutBid: 3n * ONE_18, amountOutAsk: 5n * ONE_18 },
      { amountOutMid: 2n * ONE_18, amountOutBid: 1n * ONE_18, amountOutAsk: 2n * ONE_18 },
    )).toBe((3n * ONE_18) / 2n)
  })

  it('preserves missing-price state when adapting optional values', () => {
    expect(toUsdAmount(undefined)).toEqual({ usd: 0, hasPrice: false })
    expect(toUsdAmount(1.25)).toEqual({ usd: 1.25, hasPrice: true })
  })
})
