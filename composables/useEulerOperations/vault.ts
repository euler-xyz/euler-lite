import type { Address, Hash } from 'viem'
import { encodeFunctionData, getAddress } from 'viem'
import type { OperationsContext, OperationHelpers, Permit2Helpers, AllowanceHelpers } from './types'
import { erc20ApproveAbi, erc20TransferAbi } from '~/abis/erc20'
import { evcEnableCollateralAbi, evcEnableControllerAbi } from '~/abis/evc'
import { vaultBorrowAbi, vaultDepositAbi, vaultPreviewWithdrawAbi, vaultRedeemAbi, vaultWithdrawAbi } from '~/abis/vault'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import { swapperAbi, swapVerifierAbi } from '~/entities/euler/abis'
import { convertSaHooksToEVCCalls, type EVCCall } from '~/utils/evc-converter'
import { getNewSubAccount } from '~/entities/account'
import { buildCollateralCleanupCalls } from '~/utils/collateral-cleanup'
import type { TxPlan, TxStep } from '~/entities/txPlan'
import type { SwapApiQuote } from '~/entities/swap'
import { SwapperMode, SwapVerificationType } from '~/entities/swap'
import { logWarn } from '~/utils/errorHandling'
import { assertSwapperAllowed } from '~/utils/swap-validation'

export const createVaultBuilders = (
  ctx: OperationsContext,
  helpers: OperationHelpers,
  _permit2: Permit2Helpers,
  _allowanceHelpers: AllowanceHelpers,
) => {
  const buildSupplyPlan = async (
    vaultAddress: string,
    assetAddress: string,
    amount: bigint,
    subAccount?: string,
    options: { includePermit2Call?: boolean } = {},
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const assetAddr = assetAddress as Address
    const userAddr = ctx.address.value as Address
    const depositToAddr = subAccount ? (subAccount as Address) : userAddr

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr,
      spenderAddr: vaultAddr,
      userAddr,
      amount,
      includePermit2Call: options.includePermit2Call ?? true,
    })

    const tos = await helpers.prepareTos(userAddr)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(assetAddr, erc20ApproveAbi)
    hooks.addContractInterface(vaultAddr, vaultDepositAbi)
    tos.addTosInterface(hooks)

    hooks.setMainCallHookCallFromSelf(vaultAddr, 'deposit', [amount, depositToAddr])

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, depositToAddr)

    tos.injectTosCall(evcCalls, hooks)

    if (permitCall) {
      evcCalls.unshift(permitCall)
    }

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 supply via EVC' : 'Supply via EVC',
    }))

    return { kind: 'supply', steps }
  }

  const buildWithdrawPlan = async (
    vaultAddress: string,
    assetsAmount: bigint,
    subAccount?: string,
    options: { includePythUpdate?: boolean, liabilityVault?: string, enabledCollaterals?: string[] } = {},
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const userAddr = ctx.address.value as Address
    const withdrawFromAddr = subAccount ? (subAccount as Address) : userAddr

    const tos = await helpers.prepareTos(userAddr)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultWithdrawAbi)
    tos.addTosInterface(hooks)

    if (subAccount) {
      hooks.setMainCallHookCallFromSA(vaultAddr, 'withdraw', [assetsAmount, userAddr, withdrawFromAddr])
    }
    else {
      hooks.setMainCallHookCallFromSelf(vaultAddr, 'withdraw', [assetsAmount, userAddr, withdrawFromAddr])
    }

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, withdrawFromAddr)

    tos.injectTosCall(evcCalls, hooks)

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
      kind: 'withdraw',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Withdraw via EVC' })],
    }
  }

  const buildRedeemPlan = async (
    vaultAddress: string,
    assetsAmount: bigint,
    maxSharesAmount?: bigint,
    isMax?: boolean,
    subAccount?: string,
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const userAddr = ctx.address.value as Address
    const redeemFromAddr = subAccount ? (subAccount as Address) : userAddr

    const tos = await helpers.prepareTos(userAddr)

    let sharesAmount = isMax
      ? maxSharesAmount || 0n
      : await ctx.rpcProvider.readContract({
        address: vaultAddr,
        abi: vaultPreviewWithdrawAbi,
        functionName: 'previewWithdraw',
        args: [assetsAmount],
      }).catch(() => 0n) as bigint

    if (isMax === false && maxSharesAmount && (sharesAmount > maxSharesAmount)) {
      sharesAmount = maxSharesAmount
    }

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultRedeemAbi)
    tos.addTosInterface(hooks)

    if (subAccount) {
      hooks.setMainCallHookCallFromSA(vaultAddr, 'redeem', [sharesAmount, userAddr, redeemFromAddr])
    }
    else {
      hooks.setMainCallHookCallFromSelf(vaultAddr, 'redeem', [sharesAmount, userAddr, redeemFromAddr])
    }

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, redeemFromAddr)

    tos.injectTosCall(evcCalls, hooks)

    return {
      kind: 'withdraw',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Withdraw via EVC' })],
    }
  }

  const buildBorrowPlan = async (
    vaultAddress: string,
    assetAddress: string,
    amount: bigint,
    borrowVaultAddress: string,
    borrowAmount: bigint,
    subAccount?: string,
    options: { includePermit2Call?: boolean, enabledCollaterals?: string[] } = {},
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const assetAddr = assetAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    const subAccountAddr = (subAccount || await getNewSubAccount(ctx.address.value)) as Address

    const tos = await helpers.prepareTos(userAddr)

    const steps: TxStep[] = []
    let permitCall: EVCCall | undefined
    let usesPermit2 = false

    if (amount > 0n) {
      const approval = await helpers.prepareTokenApproval({
        assetAddr,
        spenderAddr: vaultAddr,
        userAddr,
        amount,
        includePermit2Call: options.includePermit2Call ?? true,
      })
      steps.push(...approval.steps)
      permitCall = approval.permitCall
      usesPermit2 = approval.usesPermit2
    }

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultDepositAbi)
    hooks.addContractInterface(borrowVaultAddr, vaultBorrowAbi)
    hooks.addContractInterface(evcAddress, [...evcEnableControllerAbi, ...evcEnableCollateralAbi])
    tos.addTosInterface(hooks)

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, userAddr)

    tos.injectTosCall(evcCalls, hooks)

    if (permitCall) {
      evcCalls.unshift(permitCall)
    }

    const cleanupCalls = await buildCollateralCleanupCalls({
      evcAddress,
      accountLensAddress: ctx.eulerLensAddresses.value!.accountLens as Address,
      subAccount: subAccountAddr as Address,
      providerUrl: ctx.EVM_PROVIDER_URL,
      subgraphUrl: ctx.SUBGRAPH_URL,
    })
    if (cleanupCalls.length) {
      evcCalls.push(...cleanupCalls)
    }

    const depositCall: EVCCall = {
      targetContract: vaultAddr,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: hooks.getDataForCall(vaultAddr, 'deposit', [amount, subAccountAddr]) as Hash,
    }

    const enableControllerCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableController', [subAccountAddr, borrowVaultAddr]) as Hash,
    }

    const enableCollateralCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableCollateral', [subAccountAddr, vaultAddr]) as Hash,
    }

    const borrowCall: EVCCall = {
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'borrow', [borrowAmount, userAddr]) as Hash,
    }

    evcCalls.push(depositCall, enableControllerCall, enableCollateralCall, borrowCall)

    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: borrowVaultAddr,
      enabledCollaterals: options.enabledCollaterals,
      additionalCollaterals: [vaultAddr],
      userAddr,
    })

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 borrow via EVC' : 'Borrow via EVC',
    }))

    return { kind: 'borrow', steps }
  }

  const buildBorrowBySavingPlan = async (
    vaultAddress: string,
    amount: bigint,
    borrowVaultAddress: string,
    borrowAmount: bigint,
    subAccount?: string,
    enabledCollaterals?: string[],
    savingsSubAccount?: string,
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    const subAccountAddr = (subAccount || await getNewSubAccount(ctx.address.value)) as Address

    const isSavingsAtSubAccount = savingsSubAccount
      && getAddress(savingsSubAccount) !== getAddress(userAddr)

    const tos = await helpers.prepareTos(userAddr)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, erc20TransferAbi)
    hooks.addContractInterface(borrowVaultAddr, vaultBorrowAbi)
    hooks.addContractInterface(evcAddress, [...evcEnableCollateralAbi, ...evcEnableControllerAbi])
    tos.addTosInterface(hooks)

    if (!isSavingsAtSubAccount) {
      hooks.addPreHookCallFromSelf(vaultAddr, 'transfer', [subAccountAddr, amount])
    }

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, userAddr)

    tos.injectTosCall(evcCalls, hooks)

    if (isSavingsAtSubAccount) {
      const transferCall: EVCCall = {
        targetContract: vaultAddr,
        onBehalfOfAccount: getAddress(savingsSubAccount!) as Address,
        value: 0n,
        data: hooks.getDataForCall(vaultAddr, 'transfer', [subAccountAddr, amount]) as Hash,
      }
      evcCalls.push(transferCall)
    }

    const cleanupCalls = await buildCollateralCleanupCalls({
      evcAddress,
      accountLensAddress: ctx.eulerLensAddresses.value!.accountLens as Address,
      subAccount: subAccountAddr as Address,
      providerUrl: ctx.EVM_PROVIDER_URL,
      subgraphUrl: ctx.SUBGRAPH_URL,
    })
    if (cleanupCalls.length) {
      evcCalls.push(...cleanupCalls)
    }

    const enableControllerCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableController', [subAccountAddr, borrowVaultAddr]) as Hash,
    }

    const enableCollateralCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableCollateral', [subAccountAddr, vaultAddr]) as Hash,
    }

    const borrowCall: EVCCall = {
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'borrow', [borrowAmount, userAddr]) as Hash,
    }

    evcCalls.push(enableControllerCall, enableCollateralCall, borrowCall)

    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: borrowVaultAddr,
      enabledCollaterals,
      additionalCollaterals: [vaultAddr],
      userAddr,
    })

    return {
      kind: 'borrow',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Borrow via EVC' })],
    }
  }

  const buildMultiplyPlan = async ({
    supplyVaultAddress,
    supplyAssetAddress,
    supplyAmount,
    supplySharesAmount,
    supplyIsSavings = false,
    longVaultAddress,
    longAssetAddress,
    borrowVaultAddress,
    debtAmount,
    quote,
    swapperMode = SwapperMode.EXACT_IN,
    subAccount,
    includePermit2Call = true,
    enabledCollaterals,
  }: {
    supplyVaultAddress: string
    supplyAssetAddress: string
    supplyAmount: bigint
    supplySharesAmount?: bigint
    supplyIsSavings?: boolean
    longVaultAddress: string
    longAssetAddress: string
    borrowVaultAddress: string
    debtAmount: bigint
    quote?: SwapApiQuote
    swapperMode?: SwapperMode
    subAccount?: string
    includePermit2Call?: boolean
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const supplyVaultAddr = supplyVaultAddress as Address
    const supplyAssetAddr = supplyAssetAddress as Address
    const longVaultAddr = longVaultAddress as Address
    const longAssetAddr = longAssetAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    const subAccountAddr = (subAccount || await getNewSubAccount(ctx.address.value)) as Address
    const tos = await helpers.prepareTos(userAddr)
    const hasSwap = !!quote
    const borrowDepositAmount = hasSwap ? 0n : debtAmount
    const isSameVault = supplyVaultAddr.toLowerCase() === longVaultAddr.toLowerCase()
    const isSupplySavings = Boolean(supplyIsSavings)
    const shouldDepositSupply = !isSupplySavings
    if (isSupplySavings && (!supplySharesAmount || supplySharesAmount <= 0n)) {
      throw new Error('Supply shares amount missing')
    }
    const supplyApprovalAmount = shouldDepositSupply
      ? supplyAmount + (isSameVault ? borrowDepositAmount : 0n)
      : 0n

    const steps: TxStep[] = []
    const permitCalls: EVCCall[] = []
    let usesPermit2 = false

    const prepareApproval = async (
      assetAddr: Address,
      vaultAddr: Address,
      amount: bigint,
    ) => {
      if (amount <= 0n) {
        return { permitCall: undefined as EVCCall | undefined, usesPermit2Local: false }
      }

      const approval = await helpers.prepareTokenApproval({
        assetAddr,
        spenderAddr: vaultAddr,
        userAddr,
        amount,
        includePermit2Call,
      })
      steps.push(...approval.steps)
      return { permitCall: approval.permitCall, usesPermit2Local: approval.usesPermit2 }
    }

    if (shouldDepositSupply) {
      const supplyApproval = await prepareApproval(supplyAssetAddr, supplyVaultAddr, supplyApprovalAmount)
      if (supplyApproval.permitCall) {
        permitCalls.push(supplyApproval.permitCall)
      }
      usesPermit2 = usesPermit2 || supplyApproval.usesPermit2Local
    }

    if (borrowDepositAmount > 0n && (!isSameVault || !shouldDepositSupply)) {
      const longApproval = await prepareApproval(longAssetAddr, longVaultAddr, borrowDepositAmount)
      if (longApproval.permitCall) {
        permitCalls.push(longApproval.permitCall)
      }
      usesPermit2 = usesPermit2 || longApproval.usesPermit2Local
    }

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(supplyVaultAddr, vaultDepositAbi)
    if (isSupplySavings) {
      hooks.addContractInterface(supplyVaultAddr, erc20TransferAbi)
    }
    if (isSupplySavings) {
      hooks.addPreHookCallFromSelf(supplyVaultAddr, 'transfer', [subAccountAddr, supplySharesAmount!])
    }
    if (!isSameVault) {
      hooks.addContractInterface(longVaultAddr, vaultDepositAbi)
    }
    hooks.addContractInterface(borrowVaultAddr, vaultBorrowAbi)
    hooks.addContractInterface(evcAddress, [...evcEnableControllerAbi, ...evcEnableCollateralAbi])
    tos.addTosInterface(hooks)

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, userAddr)

    tos.injectTosCall(evcCalls, hooks)

    if (permitCalls.length) {
      evcCalls.unshift(...permitCalls)
    }

    if (shouldDepositSupply && supplyAmount > 0n) {
      const depositCall: EVCCall = {
        targetContract: supplyVaultAddr,
        onBehalfOfAccount: userAddr,
        value: 0n,
        data: hooks.getDataForCall(supplyVaultAddr, 'deposit', [supplyAmount, subAccountAddr]) as Hash,
      }
      evcCalls.push(depositCall)
    }

    const cleanupCalls = await buildCollateralCleanupCalls({
      evcAddress,
      accountLensAddress: ctx.eulerLensAddresses.value!.accountLens as Address,
      subAccount: subAccountAddr as Address,
      providerUrl: ctx.EVM_PROVIDER_URL,
      subgraphUrl: ctx.SUBGRAPH_URL,
    })
    if (cleanupCalls.length) {
      evcCalls.push(...cleanupCalls)
    }

    const enableControllerCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableController', [subAccountAddr, borrowVaultAddr]) as Hash,
    }

    const enableSupplyCollateralCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableCollateral', [subAccountAddr, supplyVaultAddr]) as Hash,
    }

    const getSwapInputAmount = (q: SwapApiQuote, mode: SwapperMode) => {
      const amountIn = BigInt(q.amountIn || 0)
      const amountInMax = BigInt(q.amountInMax || 0)
      if (mode === SwapperMode.EXACT_IN) return amountIn
      return amountInMax > 0n ? amountInMax : amountIn
    }

    if (hasSwap) {
      assertSwapperAllowed(quote!.swap.swapperAddress, ctx.eulerPeripheryAddresses.value!.swapper)
    }

    const borrowRecipient = hasSwap ? quote!.swap.swapperAddress : userAddr
    const borrowAmount = hasSwap ? getSwapInputAmount(quote!, swapperMode) : debtAmount
    if (borrowAmount <= 0n) {
      throw new Error('Borrow amount is zero')
    }

    const borrowCall: EVCCall = {
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'borrow', [borrowAmount, borrowRecipient]) as Hash,
    }

    evcCalls.push(enableControllerCall, enableSupplyCollateralCall, borrowCall)

    if (hasSwap) {
      if (quote!.verify.type !== SwapVerificationType.SkimMin) {
        throw new Error('Swap verifier type mismatch')
      }
      if (quote!.accountIn.toLowerCase() !== subAccountAddr.toLowerCase()) {
        throw new Error('Swap quote account mismatch')
      }

      const buildSwapVerifierData = ({
        q,
        mode,
        isRepay,
        targetDebt = 0n,
        currentDebt = 0n,
      }: {
        q: SwapApiQuote
        mode: SwapperMode
        isRepay: boolean
        targetDebt?: bigint
        currentDebt?: bigint
      }) => {
        let functionName: 'verifyAmountMinAndSkim' | 'verifyDebtMax'
        let amount: bigint

        if (isRepay) {
          functionName = 'verifyDebtMax'
          if (mode === SwapperMode.TARGET_DEBT) {
            amount = targetDebt
          }
          else {
            amount = currentDebt - BigInt(q.amountOutMin || 0)
            if (amount < 0n) amount = 0n
            amount = helpers.adjustForInterest(amount)
          }
        }
        else {
          functionName = 'verifyAmountMinAndSkim'
          amount = BigInt(q.amountOutMin || 0)
        }

        return encodeFunctionData({
          abi: swapVerifierAbi,
          functionName,
          args: [q.verify.vault, q.verify.account, amount, BigInt(q.verify.deadline || 0)],
        })
      }

      const verifierData = buildSwapVerifierData({
        q: quote!,
        mode: swapperMode,
        isRepay: false,
      })
      if (verifierData.toLowerCase() !== quote!.verify.verifierData.toLowerCase()) {
        logWarn('multiply', 'SwapVerifier data mismatch')
        throw new Error('SwapVerifier data mismatch')
      }

      evcCalls.push({
        targetContract: quote!.swap.swapperAddress,
        onBehalfOfAccount: quote!.accountIn as Address,
        value: 0n,
        data: encodeFunctionData({
          abi: swapperAbi,
          functionName: 'multicall',
          args: [quote!.swap.multicallItems.map(item => item.data)],
        }),
      })

      evcCalls.push({
        targetContract: quote!.verify.verifierAddress,
        onBehalfOfAccount: quote!.verify.account,
        value: 0n,
        data: verifierData,
      })
    }
    else if (debtAmount > 0n) {
      const depositBorrowedCall: EVCCall = {
        targetContract: longVaultAddr,
        onBehalfOfAccount: userAddr,
        value: 0n,
        data: hooks.getDataForCall(longVaultAddr, 'deposit', [debtAmount, subAccountAddr]) as Hash,
      }
      evcCalls.push(depositBorrowedCall)
    }

    if (!isSameVault) {
      const enableLongCollateralCall: EVCCall = {
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'enableCollateral', [subAccountAddr, longVaultAddr]) as Hash,
      }
      evcCalls.push(enableLongCollateralCall)
    }

    const addingCollaterals = isSameVault ? [supplyVaultAddr] : [supplyVaultAddr, longVaultAddr]
    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: borrowVaultAddr,
      enabledCollaterals,
      additionalCollaterals: addingCollaterals,
      userAddr,
    })

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 multiply via EVC' : 'Multiply via EVC',
    }))

    return { kind: 'multiply', steps }
  }

  return {
    buildSupplyPlan,
    buildWithdrawPlan,
    buildRedeemPlan,
    buildBorrowPlan,
    buildBorrowBySavingPlan,
    buildMultiplyPlan,
  }
}
