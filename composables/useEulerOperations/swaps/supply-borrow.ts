import type { Address, Hash } from 'viem'
import { encodeFunctionData } from 'viem'
import type { OperationsContext, OperationHelpers } from '../types'
import { buildSwapVerifierData } from './verify'
import { evcDisableCollateralAbi, evcDisableControllerAbi, evcEnableCollateralAbi, evcEnableControllerAbi } from '~/abis/evc'
import { vaultBorrowAbi, vaultRedeemAbi, vaultTransferFromMaxAbi, vaultWithdrawAbi } from '~/abis/vault'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import { swapperAbi, swapVerifierAbi, transferFromSenderAbi } from '~/entities/euler/abis'
import { convertSaHooksToEVCCalls, type EVCCall } from '~/utils/evc-converter'
import { getNewSubAccount } from '~/entities/account'
import { buildCollateralCleanupCalls } from '~/utils/collateral-cleanup'
import type { TxPlan } from '~/entities/txPlan'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { logWarn } from '~/utils/errorHandling'
import { assertSwapQuoteContractsAllowed } from '~/utils/swap-validation'

export const createSupplyBorrowSwapBuilders = (
  ctx: OperationsContext,
  helpers: OperationHelpers,
) => {
  /**
   * Swap an arbitrary token from the user's wallet and deposit the output into a vault.
   */
  const buildSwapAndSupplyPlan = async ({
    inputTokenAddress,
    inputAmount,
    quote,
    requestedSlippage,
    includePermit2Call = true,
    wrappedNativeInfo,
  }: {
    inputTokenAddress: Address
    inputAmount: bigint
    quote: SwapApiQuote
    requestedSlippage: number
    includePermit2Call?: boolean
    wrappedNativeInfo?: { wrappedTokenAddress: Address, nativeAmount: bigint }
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const swapVerifierAddress = ctx.eulerPeripheryAddresses.value.swapVerifier as Address

    assertSwapQuoteContractsAllowed({
      swapperAddress: quote.swap.swapperAddress,
      verifierAddress: quote.verify.verifierAddress,
    }, ctx.eulerPeripheryAddresses.value)

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr: inputTokenAddress,
      spenderAddr: swapVerifierAddress,
      userAddr,
      amount: inputAmount,
      includePermit2Call,
    })

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(swapVerifierAddress, [...transferFromSenderAbi, ...swapVerifierAbi])
    hooks.addContractInterface(quote.swap.swapperAddress, swapperAbi)

    const evcCalls: EVCCall[] = []

    if (permitCall) {
      evcCalls.push(permitCall)
    }

    // Wrap native currency to ERC-20 (e.g. ETH → WETH) before transferFromSender
    if (wrappedNativeInfo) {
      evcCalls.push(...helpers.buildNativeWrapCalls({
        wrappedTokenAddress: wrappedNativeInfo.wrappedTokenAddress,
        amount: wrappedNativeInfo.nativeAmount,
        userAddr,
      }))
    }

    // transferFromSender: pull tokens from wallet to swapper
    evcCalls.push({
      targetContract: swapVerifierAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: hooks.getDataForCall(swapVerifierAddress, 'transferFromSender', [inputTokenAddress, inputAmount, quote.swap.swapperAddress]) as Hash,
    })

    // Swapper multicall
    evcCalls.push({
      targetContract: quote.swap.swapperAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [quote.swap.multicallItems.map(item => item.data)],
      }),
    })

    // Verify min output and skim into vault
    if (quote.verify.type !== SwapVerificationType.SkimMin) {
      throw new Error('Swap verifier type mismatch')
    }

    const verifierData = buildSwapVerifierData({ quote, swapperMode: SwapperMode.EXACT_IN, isRepay: false, requestedSlippage })
    if (verifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
      logWarn('swap-supply', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    evcCalls.push({
      targetContract: quote.verify.verifierAddress,
      onBehalfOfAccount: quote.verify.account,
      value: 0n,
      data: verifierData,
    })

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 swap & supply via EVC' : 'Swap & supply via EVC',
    }))

    return { kind: 'swap-supply', steps }
  }

  /**
   * Swap an arbitrary token from the user's wallet to the collateral vault's underlying,
   * deposit as collateral, enable controller + collateral, and borrow.
   */
  const buildSwapAndBorrowPlan = async ({
    inputTokenAddress,
    inputAmount,
    collateralVaultAddress,
    borrowVaultAddress,
    borrowAmount: borrowAmountParam,
    swapQuote,
    requestedSlippage,
    subAccount,
    enabledCollaterals,
    includePermit2Call = true,
    wrappedNativeInfo,
  }: {
    inputTokenAddress: Address
    inputAmount: bigint
    collateralVaultAddress: Address
    borrowVaultAddress: Address
    borrowAmount: bigint
    swapQuote: SwapApiQuote
    requestedSlippage: number
    subAccount?: string
    enabledCollaterals?: string[]
    includePermit2Call?: boolean
    wrappedNativeInfo?: { wrappedTokenAddress: Address, nativeAmount: bigint }
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const swapVerifierAddress = ctx.eulerPeripheryAddresses.value.swapVerifier as Address

    assertSwapQuoteContractsAllowed({
      swapperAddress: swapQuote.swap.swapperAddress,
      verifierAddress: swapQuote.verify.verifierAddress,
    }, ctx.eulerPeripheryAddresses.value)

    const subAccountAddr = (subAccount || await getNewSubAccount(ctx.address.value)) as Address

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr: inputTokenAddress,
      spenderAddr: swapVerifierAddress,
      userAddr,
      amount: inputAmount,
      includePermit2Call,
    })

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(swapVerifierAddress, [...transferFromSenderAbi, ...swapVerifierAbi])
    hooks.addContractInterface(swapQuote.swap.swapperAddress, swapperAbi)
    hooks.addContractInterface(evcAddress, [...evcEnableControllerAbi, ...evcEnableCollateralAbi])
    hooks.addContractInterface(borrowVaultAddress, vaultBorrowAbi)

    const evcCalls: EVCCall[] = []

    if (permitCall) {
      evcCalls.push(permitCall)
    }

    // Wrap native currency to ERC-20 (e.g. ETH → WETH) before transferFromSender
    if (wrappedNativeInfo) {
      evcCalls.push(...helpers.buildNativeWrapCalls({
        wrappedTokenAddress: wrappedNativeInfo.wrappedTokenAddress,
        amount: wrappedNativeInfo.nativeAmount,
        userAddr,
      }))
    }

    // transferFromSender: pull tokens from wallet to swapper
    evcCalls.push({
      targetContract: swapVerifierAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: hooks.getDataForCall(swapVerifierAddress, 'transferFromSender', [inputTokenAddress, inputAmount, swapQuote.swap.swapperAddress]) as Hash,
    })

    // Swapper multicall
    evcCalls.push({
      targetContract: swapQuote.swap.swapperAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [swapQuote.swap.multicallItems.map(item => item.data)],
      }),
    })

    // Verify min output and skim into collateral vault
    if (swapQuote.verify.type !== SwapVerificationType.SkimMin) {
      throw new Error('Swap verifier type mismatch')
    }

    const verifierData = buildSwapVerifierData({ quote: swapQuote, swapperMode: SwapperMode.EXACT_IN, isRepay: false, requestedSlippage })
    if (verifierData.toLowerCase() !== swapQuote.verify.verifierData.toLowerCase()) {
      logWarn('swap-borrow', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    evcCalls.push({
      targetContract: swapQuote.verify.verifierAddress,
      onBehalfOfAccount: swapQuote.verify.account,
      value: 0n,
      data: verifierData,
    })

    // Enable controller
    evcCalls.push({
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableController', [subAccountAddr, borrowVaultAddress]) as Hash,
    })

    // Enable collateral
    evcCalls.push({
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableCollateral', [subAccountAddr, collateralVaultAddress]) as Hash,
    })

    // Borrow
    evcCalls.push({
      targetContract: borrowVaultAddress,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddress, 'borrow', [borrowAmountParam, userAddr]) as Hash,
    })

    // Collateral cleanup
    const cleanupCalls = await buildCollateralCleanupCalls({
      evcAddress,
      accountLensAddress: ctx.eulerLensAddresses.value!.accountLens as Address,
      subAccount: subAccountAddr,
      providerUrl: ctx.rpcUrl,
      subgraphUrl: ctx.SUBGRAPH_URL,
    })
    if (cleanupCalls.length) {
      // Insert cleanup before the borrow-related calls
      evcCalls.splice(evcCalls.length - 3, 0, ...cleanupCalls)
    }

    // Pyth updates for health check
    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: borrowVaultAddress,
      enabledCollaterals,
      additionalCollaterals: [collateralVaultAddress],
      userAddr,
    })

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 swap & borrow via EVC' : 'Swap & borrow via EVC',
    }))

    return { kind: 'swap-borrow', steps }
  }

  const buildWithdrawAndSwapPlan = async ({
    vaultAddress: vaultAddr,
    assetsAmount,
    quote,
    requestedSlippage,
    subAccount,
    options = {},
  }: {
    vaultAddress: Address
    assetsAmount: bigint
    quote: SwapApiQuote
    requestedSlippage: number
    subAccount?: string
    options?: { includePythUpdate?: boolean, liabilityVault?: string, enabledCollaterals?: string[] }
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const withdrawFromAddr = subAccount ? (subAccount as Address) : userAddr
    const swapperAddress = quote.swap.swapperAddress as Address

    assertSwapQuoteContractsAllowed({
      swapperAddress: quote.swap.swapperAddress,
      verifierAddress: quote.verify.verifierAddress,
    }, ctx.eulerPeripheryAddresses.value)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultWithdrawAbi)
    hooks.addContractInterface(swapperAddress, swapperAbi)

    // Withdraw to swapper (not to user wallet)
    if (subAccount) {
      hooks.setMainCallHookCallFromSA(vaultAddr, 'withdraw', [assetsAmount, swapperAddress, withdrawFromAddr])
    }
    else {
      hooks.setMainCallHookCallFromSelf(vaultAddr, 'withdraw', [assetsAmount, swapperAddress, withdrawFromAddr])
    }

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, withdrawFromAddr)

    // Swapper multicall
    evcCalls.push({
      targetContract: swapperAddress,
      onBehalfOfAccount: quote.accountIn as Address,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [quote.swap.multicallItems.map(item => item.data)],
      }),
    })

    // Verify min output
    if (quote.verify.type !== SwapVerificationType.TransferMin) {
      throw new Error('Swap verifier type mismatch')
    }

    const verifierData = buildSwapVerifierData({ quote, swapperMode: SwapperMode.EXACT_IN, isRepay: false, requestedSlippage })
    if (verifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
      logWarn('swap-withdraw', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    evcCalls.push({
      targetContract: quote.verify.verifierAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: verifierData,
    })

    // Pyth price updates (when position has borrows)
    if (options.includePythUpdate) {
      const liabilityAddr = options.liabilityVault || vaultAddr
      await helpers.injectPythHealthCheckUpdates({
        evcCalls,
        liabilityVaultAddr: liabilityAddr,
        enabledCollaterals: options.enabledCollaterals,
        userAddr,
      })
    }

    return {
      kind: 'swap-withdraw',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Withdraw & swap via EVC' })],
    }
  }

  /**
   * Redeem all shares from a vault and swap the underlying to an arbitrary output token.
   */
  const buildRedeemAndSwapPlan = async ({
    vaultAddress: vaultAddr,
    sharesAmount,
    quote,
    requestedSlippage,
    subAccount,
    options = {},
  }: {
    vaultAddress: Address
    sharesAmount: bigint
    quote: SwapApiQuote
    requestedSlippage: number
    subAccount?: string
    options?: { includePythUpdate?: boolean, liabilityVault?: string, enabledCollaterals?: string[] }
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const redeemFromAddr = subAccount ? (subAccount as Address) : userAddr
    const swapperAddress = quote.swap.swapperAddress as Address

    assertSwapQuoteContractsAllowed({
      swapperAddress: quote.swap.swapperAddress,
      verifierAddress: quote.verify.verifierAddress,
    }, ctx.eulerPeripheryAddresses.value)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultRedeemAbi)
    hooks.addContractInterface(swapperAddress, swapperAbi)

    // Redeem shares to swapper (not to user wallet)
    if (subAccount) {
      hooks.setMainCallHookCallFromSA(vaultAddr, 'redeem', [sharesAmount, swapperAddress, redeemFromAddr])
    }
    else {
      hooks.setMainCallHookCallFromSelf(vaultAddr, 'redeem', [sharesAmount, swapperAddress, redeemFromAddr])
    }

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, redeemFromAddr)

    // Swapper multicall
    evcCalls.push({
      targetContract: swapperAddress,
      onBehalfOfAccount: quote.accountIn as Address,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [quote.swap.multicallItems.map(item => item.data)],
      }),
    })

    // Verify min output
    if (quote.verify.type !== SwapVerificationType.TransferMin) {
      throw new Error('Swap verifier type mismatch')
    }

    const redeemVerifierData = buildSwapVerifierData({ quote, swapperMode: SwapperMode.EXACT_IN, isRepay: false, requestedSlippage })
    if (redeemVerifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
      logWarn('swap-redeem', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    evcCalls.push({
      targetContract: quote.verify.verifierAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: redeemVerifierData,
    })

    // Pyth price updates
    if (options.includePythUpdate) {
      const liabilityAddr = options.liabilityVault || vaultAddr
      await helpers.injectPythHealthCheckUpdates({
        evcCalls,
        liabilityVaultAddr: liabilityAddr,
        enabledCollaterals: options.enabledCollaterals,
        userAddr,
      })
    }

    return {
      kind: 'swap-withdraw',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Withdraw & swap via EVC' })],
    }
  }

  /**
   * Swap an arbitrary token from the user's wallet and repay debt via verifyDebtMax.
   * Supports both EXACT_IN and TARGET_DEBT modes. Optionally cleans up the position on full repay.
   */
  const buildSwapAndRepayPlan = async ({
    inputTokenAddress,
    inputAmount,
    quote,
    requestedSlippage,
    borrowVaultAddress,
    subAccount,
    enabledCollaterals,
    isFullRepay = false,
    swapperMode = SwapperMode.EXACT_IN,
    targetDebt = 0n,
    currentDebt = 0n,
    includePermit2Call = true,
    wrappedNativeInfo,
  }: {
    inputTokenAddress: Address
    inputAmount: bigint
    quote: SwapApiQuote
    requestedSlippage: number
    borrowVaultAddress: Address
    subAccount: Address
    enabledCollaterals?: string[]
    isFullRepay?: boolean
    swapperMode?: SwapperMode
    targetDebt?: bigint
    currentDebt?: bigint
    includePermit2Call?: boolean
    wrappedNativeInfo?: { wrappedTokenAddress: Address, nativeAmount: bigint }
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const swapVerifierAddress = ctx.eulerPeripheryAddresses.value.swapVerifier as Address
    const borrowVaultAddr = borrowVaultAddress

    assertSwapQuoteContractsAllowed({
      swapperAddress: quote.swap.swapperAddress,
      verifierAddress: quote.verify.verifierAddress,
    }, ctx.eulerPeripheryAddresses.value)

    if (quote.verify.type !== SwapVerificationType.DebtMax) {
      throw new Error('Swap verifier type mismatch')
    }

    const verifierData = buildSwapVerifierData({ quote, swapperMode, isRepay: true, requestedSlippage, targetDebt, currentDebt })
    if (verifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
      logWarn('swap-repay', 'SwapVerifier data mismatch')
      throw new Error('SwapVerifier data mismatch')
    }

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr: inputTokenAddress,
      spenderAddr: swapVerifierAddress,
      userAddr,
      amount: inputAmount,
      includePermit2Call,
    })

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(swapVerifierAddress, [...transferFromSenderAbi, ...swapVerifierAbi])
    hooks.addContractInterface(quote.swap.swapperAddress, swapperAbi)

    if (isFullRepay) {
      hooks.addContractInterface(borrowVaultAddr, evcDisableControllerAbi)
      hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)
      const collateralAddresses = enabledCollaterals || []
      for (const collateralAddr of collateralAddresses) {
        hooks.addContractInterface(collateralAddr as Address, vaultTransferFromMaxAbi)
      }
    }

    const evcCalls: EVCCall[] = []

    if (permitCall) {
      evcCalls.push(permitCall)
    }

    // Wrap native currency to ERC-20 (e.g. ETH → WETH) before transferFromSender
    if (wrappedNativeInfo) {
      evcCalls.push(...helpers.buildNativeWrapCalls({
        wrappedTokenAddress: wrappedNativeInfo.wrappedTokenAddress,
        amount: wrappedNativeInfo.nativeAmount,
        userAddr,
      }))
    }

    // transferFromSender: pull tokens from wallet to swapper
    evcCalls.push({
      targetContract: swapVerifierAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: hooks.getDataForCall(swapVerifierAddress, 'transferFromSender', [inputTokenAddress, inputAmount, quote.swap.swapperAddress]) as Hash,
    })

    // Swapper multicall
    evcCalls.push({
      targetContract: quote.swap.swapperAddress,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: encodeFunctionData({
        abi: swapperAbi,
        functionName: 'multicall',
        args: [quote.swap.multicallItems.map(item => item.data)],
      }),
    })

    // Verify debt max — handles skim + repay internally
    evcCalls.push({
      targetContract: quote.verify.verifierAddress,
      onBehalfOfAccount: quote.verify.account,
      value: 0n,
      data: verifierData,
    })

    if (isFullRepay) {
      // Disable controller
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: subAccount,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'disableController', []) as Hash,
      })

      // Disable collateral
      const collateralAddresses = enabledCollaterals || []
      for (const collateralAddr of collateralAddresses) {
        evcCalls.push({
          targetContract: evcAddress,
          onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
          value: 0n,
          data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccount, collateralAddr as Address]) as Hash,
        })
      }

      // Transfer collateral shares back to main account
      const isMainAccount = subAccount.toLowerCase() === userAddr.toLowerCase()
      if (!isMainAccount) {
        for (const collateralAddr of collateralAddresses) {
          evcCalls.push({
            targetContract: collateralAddr as Address,
            onBehalfOfAccount: subAccount,
            value: 0n,
            data: hooks.getDataForCall(collateralAddr as Address, 'transferFromMax', [subAccount, userAddr]) as Hash,
          })
        }
      }
    }
    else {
      // Partial repay: prepend Pyth updates for health check
      await helpers.injectPythHealthCheckUpdates({
        evcCalls,
        liabilityVaultAddr: borrowVaultAddr,
        enabledCollaterals,
        userAddr,
      })
    }

    const kind = isFullRepay ? 'swap-wallet-full-repay' : 'swap-wallet-repay'
    const label = usesPermit2 ? 'Permit2 swap & repay via EVC' : 'Swap & repay via EVC'

    steps.push(helpers.buildEvcBatchStep({ evcCalls, label }))

    return { kind, steps }
  }

  return {
    buildSwapAndSupplyPlan,
    buildSwapAndBorrowPlan,
    buildSwapAndRepayPlan,
    buildWithdrawAndSwapPlan,
    buildRedeemAndSwapPlan,
  }
}
