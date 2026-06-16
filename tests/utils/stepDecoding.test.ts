import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { buildTransactionPlanDisplaySteps, type StepDecodingContext, type VaultLookup } from '~/utils/stepDecoding'

const verifier = '0x0000000000000000000000000000000000000001' as Address
const account = '0x0000000000000000000000000000000000000002' as Address
const usdcVault = '0x0000000000000000000000000000000000000011' as Address
const daiVault = '0x0000000000000000000000000000000000000012' as Address
const weethVault = '0x0000000000000000000000000000000000000013' as Address
const wethVault = '0x0000000000000000000000000000000000000014' as Address
const cbBtcVault = '0x0000000000000000000000000000000000000015' as Address
const usdcAsset = '0x0000000000000000000000000000000000000021' as Address
const daiAsset = '0x0000000000000000000000000000000000000022' as Address
const weethAsset = '0x0000000000000000000000000000000000000023' as Address
const wethAsset = '0x0000000000000000000000000000000000000024' as Address
const cbBtcAsset = '0x0000000000000000000000000000000000000025' as Address

const swapVerifierAbi = parseAbi([
  'function verifyAmountMinAndSkim(address vault,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyAmountMinAndTransfer(address asset,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyDebtMax(address vault,address account,uint256 amountMax,uint256 deadline)',
])
const vaultAbi = parseAbi([
  'function withdraw(uint256 assets,address receiver,address owner)',
  'function borrow(uint256 assets,address receiver)',
])
const swapperAbi = parseAbi([
  'function multicall(bytes[] data)',
])

const ctx: StepDecodingContext = {
  type: 'swap',
  asset: {
    symbol: 'USDC',
    address: usdcAsset,
    decimals: 6,
  },
  amount: '100',
  swapToAsset: {
    symbol: 'DAI',
    address: daiAsset,
    decimals: 6,
  },
  swapToAmount: '99',
}

const getVault: VaultLookup = (address) => {
  const normalized = address.toLowerCase()
  if (normalized === usdcVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'USDC',
        address: usdcAsset,
        decimals: 6,
      },
    }
  }
  if (normalized === daiVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'DAI',
        address: daiAsset,
        decimals: 6,
      },
    }
  }
  if (normalized === weethVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'weETH',
        address: weethAsset,
        decimals: 18,
      },
    }
  }
  if (normalized === wethVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'WETH',
        address: wethAsset,
        decimals: 18,
      },
    }
  }
  if (normalized === cbBtcVault.toLowerCase()) {
    return {
      asset: {
        symbol: 'cbBTC',
        address: cbBtcAsset,
        decimals: 8,
      },
    }
  }
  return undefined
}

const getLogoUrl = () => ''

const batchItem = (data: Hex, targetContract: Address = verifier): EVCBatchItem => ({
  targetContract,
  onBehalfOfAccount: account,
  value: 0n,
  data,
})

const buildSteps = (data: Hex) => buildTransactionPlanDisplaySteps(
  [{
    type: 'evcBatch',
    items: [batchItem(data)],
  }] satisfies TransactionPlan,
  ctx,
  getVault,
  getLogoUrl,
)

describe('buildTransactionPlanDisplaySteps swap verifier rows', () => {
  it('shows the min received amount for skim verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndSkim',
      args: [daiVault, account, 98_765_432n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '98.765432',
      },
    })
  })

  it('shows the min received amount for transfer verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndTransfer',
      args: [daiAsset, account, 12_345_678n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify min received',
      assetInfo: {
        symbol: 'DAI',
        address: daiAsset,
        amount: '12.345678',
      },
    })
  })

  it('shows the max debt amount for debt verification', () => {
    const steps = buildSteps(encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyDebtMax',
      args: [usdcVault, account, 1_234_567n, 123n],
    }))

    expect(steps[0]).toMatchObject({
      label: 'Verify max debt',
      assetInfo: {
        symbol: 'USDC',
        address: usdcAsset,
        amount: '1.234567',
      },
    })
  })

  it('infers separate swap assets in a combined collateral and debt refinance batch', () => {
    const steps = buildTransactionPlanDisplaySteps(
      [{
        type: 'evcBatch',
        items: [
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'withdraw',
            args: [731_941n, account, account],
          }), usdcVault),
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          })),
          batchItem(encodeFunctionData({
            abi: swapVerifierAbi,
            functionName: 'verifyAmountMinAndSkim',
            args: [weethVault, account, 377_740_000_000_000n, 123n],
          })),
          batchItem(encodeFunctionData({
            abi: vaultAbi,
            functionName: 'borrow',
            args: [395_140_000_000_000n, account],
          }), wethVault),
          batchItem(encodeFunctionData({
            abi: swapperAbi,
            functionName: 'multicall',
            args: [[]],
          })),
          batchItem(encodeFunctionData({
            abi: swapVerifierAbi,
            functionName: 'verifyDebtMax',
            args: [cbBtcVault, account, 0n, 123n],
          })),
        ],
      }] satisfies TransactionPlan,
      {
        type: 'refinance',
        asset: { symbol: 'cbBTC', address: cbBtcAsset, decimals: 8 },
        amount: '0.00000994',
      },
      getVault,
      getLogoUrl,
    )

    expect(steps[0]).toMatchObject({
      label: 'Withdraw',
      assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '0.731941' },
    })
    expect(steps[1]).toMatchObject({
      label: 'Swap',
      assetInfo: { symbol: 'USDC', address: usdcAsset, amount: '0.731941' },
      toAssetInfo: { symbol: 'weETH', address: weethAsset, amount: '0.00037774' },
    })
    expect(steps[3]).toMatchObject({
      label: 'Borrow',
      assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00039514' },
    })
    expect(steps[4]).toMatchObject({
      label: 'Swap to repay',
      assetInfo: { symbol: 'WETH', address: wethAsset, amount: '0.00039514' },
      toAssetInfo: { symbol: 'cbBTC', address: cbBtcAsset },
    })
  })
})
