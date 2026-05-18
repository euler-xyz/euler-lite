import type { Address, Hash } from 'viem'
import { encodeFunctionData } from 'viem'
import type { OperationsContext, OperationHelpers } from '../types'
import { buildSwapVerifierData, getSwapInputAmount } from './verify'
import { evcDisableCollateralAbi, evcDisableControllerAbi, evcEnableCollateralAbi, evcEnableControllerAbi } from '~/abis/evc'
import { vaultBorrowAbi, vaultTransferFromMaxAbi, vaultWithdrawAbi } from '~/abis/vault'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import { swapperAbi } from '~/entities/euler/abis'
import type { EVCCall } from '~/utils/evc-converter'
import { sumCallValues } from '~/utils/pyth'
import { logWarn } from '~/utils/errorHandling'
import { assertSwapperVerifierAllowed } from '~/utils/swap-validation'
import type { TxPlan } from '~/entities/txPlan'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { isEVKVault, type Vault, type SecuritizeVault } from '~/entities/vault'

export const createCrossAssetSwapBuilders = (
  ctx: OperationsContext,
  helpers: OperationHelpers,
) => {
  // Only EVK collaterals expose `transferFromMax`. See repay.ts for the same
  // guard — kept colocated with the sweep so future builders can't forget it.
  const isSweepable = (addr: string): boolean => {
    const v = ctx.registryGetVault(addr as Address) as Vault | SecuritizeVault | undefined
    return !!v && isEVKVault(v)
  }
  const buildSwapEvcCalls = async ({
    quote,
    swapperMode,
    isRepay,
    requestedSlippage,
    targetDebt = 0n,
    currentDebt = 0n,
    enableCollateral = false,
    disableCollateral,
    liabilityVault,
    enabledCollaterals,
    isDebtSwap = false,
  }: {
    quote: SwapApiQuote
    swapperMode: SwapperMode
    isRepay: boolean
    requestedSlippage: number
    targetDebt?: bigint
    currentDebt?: bigint
    enableCollateral?: boolean
    disableCollateral?: string
    liabilityVault?: string
    enabledCollaterals?: string[]
    isDebtSwap?: boolean
  }) => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    assertSwapperVerifierAllowed(quote.verify.verifierAddress, ctx.eulerPeripheryAddresses.value.swapVerifier)

    if (isRepay && quote.verify.type !== SwapVerificationType.DebtMax) {
      throw new Error('Swap verifier type mismatch')
    }
    if (!isRepay && quote.verify.type !== SwapVerificationType.SkimMin) {
      throw new Error('Swap verifier type mismatch')
    }

    const inputAmount = getSwapInputAmount(quote, swapperMode)
    if (inputAmount <= 0n) {
      throw new Error('Swap amount is zero')
    }

    const verifierData = buildSwapVerifierData({ quote, swapperMode, isRepay, requestedSlippage, targetDebt, currentDebt })

    if (verifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
      logWarn('swap', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    const hooks = new SaHooksBuilder()
    if (isDebtSwap) {
      hooks.addContractInterface(quote.vaultIn, vaultBorrowAbi)
      hooks.addContractInterface(quote.receiver, evcDisableControllerAbi)
    }
    else {
      hooks.addContractInterface(quote.vaultIn, vaultWithdrawAbi)
    }

    const evcAbis = [
      ...(isDebtSwap ? evcEnableControllerAbi : []),
      ...(enableCollateral ? evcEnableCollateralAbi : []),
      ...(disableCollateral ? evcDisableCollateralAbi : []),
    ]
    if (evcAbis.length) {
      hooks.addContractInterface(evcAddress, evcAbis)
    }

    const evcCalls: EVCCall[] = []

    if (isDebtSwap) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'enableController', [quote.accountOut, quote.vaultIn]) as Hash,
      })
      evcCalls.push({
        targetContract: quote.vaultIn,
        onBehalfOfAccount: quote.accountOut,
        value: 0n,
        data: hooks.getDataForCall(quote.vaultIn, 'borrow', [inputAmount, quote.swap.swapperAddress]) as Hash,
      })
    }
    else {
      evcCalls.push({
        targetContract: quote.vaultIn,
        onBehalfOfAccount: quote.accountIn,
        value: 0n,
        data: hooks.getDataForCall(quote.vaultIn, 'withdraw', [inputAmount, quote.swap.swapperAddress, quote.accountIn]) as Hash,
      })
    }

    evcCalls.push({
      targetContract: quote.swap.swapperAddress,
      onBehalfOfAccount: quote.accountIn,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [quote.swap.multicallItems.map(item => item.data)],
      }),
    })

    evcCalls.push({
      targetContract: quote.verify.verifierAddress,
      onBehalfOfAccount: quote.verify.account,
      value: 0n,
      data: verifierData,
    })

    if (enableCollateral) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'enableCollateral', [quote.accountOut, quote.receiver]) as Hash,
      })
    }

    if (disableCollateral) {
      const oldVaultAddr = disableCollateral as Address
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [quote.accountOut, oldVaultAddr]) as Hash,
      })
    }

    if (isDebtSwap && quote.receiver.toLowerCase() !== quote.vaultIn.toLowerCase()) {
      evcCalls.push({
        targetContract: quote.receiver,
        onBehalfOfAccount: quote.accountOut,
        value: 0n,
        data: hooks.getDataForCall(quote.receiver, 'disableController', []) as Hash,
      })
    }

    let pythResult: { calls: EVCCall[], totalFee: bigint }
    if (liabilityVault) {
      const removingCollaterals = disableCollateral ? [disableCollateral] : []
      const effectiveCollaterals = helpers.resolveEffectiveCollaterals(enabledCollaterals, enableCollateral ? [quote.receiver] : [], removingCollaterals)
      pythResult = await helpers.preparePythUpdatesForHealthCheck(liabilityVault, effectiveCollaterals, userAddr)
    }
    else {
      pythResult = await helpers.preparePythUpdates([quote.vaultIn, quote.receiver], userAddr)
    }
    const { calls: pythCalls } = pythResult
    if (pythCalls.length) {
      evcCalls.unshift(...pythCalls as EVCCall[])
    }

    const totalValue = sumCallValues(evcCalls)

    return { evcCalls, evcAddress, totalValue }
  }

  const buildSwapPlan = async ({
    quote,
    swapperMode = SwapperMode.EXACT_IN,
    isRepay = false,
    requestedSlippage,
    targetDebt = 0n,
    currentDebt = 0n,
    enableCollateral = false,
    disableCollateral,
    liabilityVault,
    enabledCollaterals,
    isDebtSwap = false,
  }: {
    quote: SwapApiQuote
    swapperMode?: SwapperMode
    isRepay?: boolean
    requestedSlippage: number
    targetDebt?: bigint
    currentDebt?: bigint
    enableCollateral?: boolean
    disableCollateral?: string
    liabilityVault?: string
    enabledCollaterals?: string[]
    isDebtSwap?: boolean
  }): Promise<TxPlan> => {
    const { evcCalls, evcAddress: _evcAddress, totalValue: _totalValue } = await buildSwapEvcCalls({
      quote, swapperMode, isRepay, targetDebt, currentDebt,
      requestedSlippage,
      enableCollateral, disableCollateral, liabilityVault, enabledCollaterals, isDebtSwap,
    })

    return {
      kind: 'swap',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Swap via EVC' })],
    }
  }

  /**
   * Full repay using a cross-asset swap (from collateral or savings).
   */
  const buildSwapFullRepayPlan = async ({
    quote,
    swapperMode = SwapperMode.EXACT_IN,
    requestedSlippage,
    targetDebt = 0n,
    currentDebt = 0n,
    liabilityVault,
    enabledCollaterals,
    source,
  }: {
    quote: SwapApiQuote
    swapperMode?: SwapperMode
    requestedSlippage: number
    targetDebt?: bigint
    currentDebt?: bigint
    liabilityVault?: string
    enabledCollaterals?: string[]
    source: 'collateral' | 'savings'
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const subAccountAddr = (source === 'collateral' ? quote.accountIn : quote.accountOut) as Address

    const { evcCalls } = await buildSwapEvcCalls({
      quote, swapperMode, isRepay: true, targetDebt, currentDebt,
      requestedSlippage,
      liabilityVault, enabledCollaterals,
    })

    // Append position cleanup calls
    const hooks = new SaHooksBuilder()
    const borrowVaultAddr = quote.receiver as Address
    hooks.addContractInterface(borrowVaultAddr, evcDisableControllerAbi)
    hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)

    const collateralAddresses = enabledCollaterals || []
    for (const collateralAddr of collateralAddresses) {
      if (isSweepable(collateralAddr)) {
        hooks.addContractInterface(collateralAddr as Address, vaultTransferFromMaxAbi)
      }
    }

    // Disable controller
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'disableController', []) as Hash,
    })

    // Disable collateral
    for (const collateralAddr of collateralAddresses) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccountAddr, collateralAddr as Address]) as Hash,
      })
    }

    // Transfer collateral shares to main account
    const isMainAccount = subAccountAddr.toLowerCase() === userAddr.toLowerCase()
    if (!isMainAccount) {
      for (const collateralAddr of collateralAddresses) {
        if (!isSweepable(collateralAddr)) continue
        evcCalls.push({
          targetContract: collateralAddr as Address,
          onBehalfOfAccount: subAccountAddr,
          value: 0n,
          data: hooks.getDataForCall(collateralAddr as Address, 'transferFromMax', [subAccountAddr, userAddr]) as Hash,
        })
      }
    }

    const label = source === 'collateral'
      ? 'Full repay with collateral swap via EVC'
      : 'Full repay with savings swap via EVC'

    return {
      kind: `swap-${source}-full-repay`,
      steps: [helpers.buildEvcBatchStep({ evcCalls, label })],
    }
  }

  return {
    buildSwapPlan,
    buildSwapFullRepayPlan,
  }
}
