import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { buildTransactionPlanDisplaySteps, type StepDecodingContext, type VaultLookup } from '~/utils/stepDecoding'

const verifier = '0x0000000000000000000000000000000000000001' as Address
const account = '0x0000000000000000000000000000000000000002' as Address
const usdcVault = '0x0000000000000000000000000000000000000011' as Address
const daiVault = '0x0000000000000000000000000000000000000012' as Address
const usdcAsset = '0x0000000000000000000000000000000000000021' as Address
const daiAsset = '0x0000000000000000000000000000000000000022' as Address

const swapVerifierAbi = parseAbi([
  'function verifyAmountMinAndSkim(address vault,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyAmountMinAndTransfer(address asset,address receiver,uint256 amountMin,uint256 deadline)',
  'function verifyDebtMax(address vault,address account,uint256 amountMax,uint256 deadline)',
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
  return undefined
}

const getLogoUrl = () => ''

const batchItem = (data: Hex): EVCBatchItem => ({
  targetContract: verifier,
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
})
