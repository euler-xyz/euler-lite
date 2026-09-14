import { describe, expect, it } from 'vitest'
import { decodeFunctionData, maxUint256, parseAbi, toFunctionSelector } from 'viem'
import { ADDR, buildSdkAccount, buildSdkExecutionService } from './harness'
import { normalizeSdkPlan } from './normalize'

const repayWithSharesAbi = parseAbi(['function repayWithShares(uint256 amount, address receiver)'])
const repayWithSharesSelector = toFunctionSelector('repayWithShares(uint256,address)')
const disableControllerSelector = toFunctionSelector('disableController()')
const transferFromMaxSelector = toFunctionSelector('transferFromMax(address,address)')
const withdrawSelector = toFunctionSelector('withdraw(uint256,address,address)')
const skimSelector = toFunctionSelector('skim(uint256,address)')

describe('cross-position repay calldata', () => {
  it('repays reciprocal debts with shares in one atomic batch without withdrawing liquidity', () => {
    const service = buildSdkExecutionService()
    const account = buildSdkAccount({
      positions: [
        { subAccount: ADDR.user, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, shares: 2_000_000n, assets: 2_000_000n, isCollateral: true },
        { subAccount: ADDR.user, vault: ADDR.vaultDai, asset: ADDR.assetDai, borrowed: 1_000_000n },
        { subAccount: ADDR.subAccount1, vault: ADDR.vaultDai, asset: ADDR.assetDai, shares: 2_000_000n, assets: 2_000_000n, isCollateral: true },
        { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed: 1_000_000n },
      ],
    })

    const repayUsdc = service.planRepayFromDeposit({
      account,
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: maxUint256,
      receiver: ADDR.subAccount1,
      fromVault: ADDR.vaultUsdc,
      fromAccount: ADDR.user,
      cleanupOnMax: false,
    })
    const repayDai = service.planRepayFromDeposit({
      account,
      liabilityVault: ADDR.vaultDai,
      liabilityAmount: maxUint256,
      receiver: ADDR.user,
      fromVault: ADDR.vaultDai,
      fromAccount: ADDR.subAccount1,
      cleanupOnMax: false,
    })

    const transactions = normalizeSdkPlan(service.mergePlans([repayUsdc, repayDai]), ADDR.evc)
    expect(transactions).toHaveLength(1)
    const calls = transactions[0]?.evcBatch ?? []
    const repayCalls = calls.filter(call => call.selector === repayWithSharesSelector)

    expect(repayCalls).toHaveLength(2)
    expect(repayCalls.map((call) => {
      const decoded = decodeFunctionData({ abi: repayWithSharesAbi, data: call.data })
      return {
        vault: call.targetContract,
        fromAccount: call.onBehalfOfAccount,
        amount: decoded.args[0],
        receiver: decoded.args[1],
      }
    })).toEqual([
      {
        vault: ADDR.vaultUsdc,
        fromAccount: ADDR.user,
        amount: maxUint256,
        receiver: ADDR.subAccount1,
      },
      {
        vault: ADDR.vaultDai,
        fromAccount: ADDR.subAccount1,
        amount: maxUint256,
        receiver: ADDR.user,
      },
    ])
    expect(calls.filter(call => call.selector === disableControllerSelector).map(call => ({
      vault: call.targetContract,
      account: call.onBehalfOfAccount,
    }))).toEqual([
      { vault: ADDR.vaultUsdc, account: ADDR.subAccount1 },
      { vault: ADDR.vaultDai, account: ADDR.user },
    ])
    expect(calls.some(call => call.selector === withdrawSelector)).toBe(false)
    expect(calls.some(call => call.selector === skimSelector)).toBe(false)
    expect(calls.some(call => call.selector === transferFromMaxSelector)).toBe(false)
  })
})
