import type { Address, Hash } from 'viem'
import { maxUint256 } from 'viem'
import { adjustForInterest } from './helpers'
import { hasPreExistingVaultDeposit } from './preExistingDeposit'
import type { OperationsContext, OperationHelpers } from './types'
import { evcDisableCollateralAbi, evcDisableControllerAbi } from '~/abis/evc'
import { vaultRepayAbi, vaultRepayWithSharesAbi, vaultRedeemAbi, vaultSkimAbi, vaultTransferFromMaxAbi, vaultWithdrawAbi } from '~/abis/vault'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import { convertSaHooksToEVCCalls, type EVCCall } from '~/utils/evc-converter'
import type { TxPlan } from '~/entities/txPlan'

export const createRepayBuilders = (
  ctx: OperationsContext,
  helpers: OperationHelpers,
) => {
  const buildRepayPlan = async (
    borrowVaultAddress: string,
    borrowAssetAddress: string,
    amount: bigint,
    subAccount: string,
    options: { includePermit2Call?: boolean } = {},
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const borrowVaultAddr = borrowVaultAddress as Address
    const borrowAssetAddr = borrowAssetAddress as Address
    const userAddr = ctx.address.value as Address
    const subAccountAddr = subAccount as Address

    const adjustedAmount = adjustForInterest(amount)

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr: borrowAssetAddr,
      spenderAddr: borrowVaultAddr,
      userAddr,
      amount: adjustedAmount,
      includePermit2Call: options.includePermit2Call ?? true,
    })

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(borrowVaultAddr, vaultRepayAbi)

    hooks.setMainCallHookCallFromSelf(borrowVaultAddr, 'repay', [amount, subAccountAddr])

    const saHooks = hooks.build()
    const evcCalls = convertSaHooksToEVCCalls(saHooks, userAddr, subAccountAddr)

    if (permitCall) {
      evcCalls.unshift(permitCall)
    }

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 repay via EVC' : 'Repay via EVC',
    }))

    return { kind: 'repay', steps }
  }

  // Pyth oracle updates are intentionally omitted: the batch ends with disableController
  // which removes the controller vault. With no active controller at batch end, the EVC
  // skips account health checks, so oracle prices are not needed.
  const buildFullRepayPlan = async (
    borrowVaultAddress: string,
    borrowAssetAddress: string,
    amount: bigint,
    subAccount: string,
    collateralAddresses: string[],
    options: { includePermit2Call?: boolean } = {},
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const borrowVaultAddr = borrowVaultAddress as Address
    const borrowAssetAddr = borrowAssetAddress as Address
    const userAddr = ctx.address.value as Address
    const subAccountAddr = subAccount as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    const adjustedAmount = adjustForInterest(amount)

    const { steps, permitCall, usesPermit2 } = await helpers.prepareTokenApproval({
      assetAddr: borrowAssetAddr,
      spenderAddr: borrowVaultAddr,
      userAddr,
      amount: adjustedAmount,
      includePermit2Call: options.includePermit2Call ?? true,
    })

    const collateralAddrs = collateralAddresses.map(addr => addr as Address)

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(borrowVaultAddr, [...vaultRepayAbi, ...evcDisableControllerAbi])
    hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)

    for (const collateralAddr of collateralAddrs) {
      hooks.addContractInterface(collateralAddr, vaultTransferFromMaxAbi)
    }

    const evcCalls: EVCCall[] = []

    if (permitCall) {
      evcCalls.push(permitCall)
    }

    const repayCall: EVCCall = {
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: userAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'repay', [maxUint256, subAccountAddr]) as Hash,
    }

    const disableControllerCall: EVCCall = {
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'disableController', []) as Hash,
    }

    evcCalls.push(repayCall, disableControllerCall)

    const isMainAccount = subAccountAddr.toLowerCase() === userAddr.toLowerCase()

    for (const collateralAddr of collateralAddrs) {
      const disableCollateralCall: EVCCall = {
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccountAddr, collateralAddr]) as Hash,
      }
      evcCalls.push(disableCollateralCall)

      if (!isMainAccount) {
        const transferCall: EVCCall = {
          targetContract: collateralAddr,
          onBehalfOfAccount: subAccountAddr,
          value: 0n,
          data: hooks.getDataForCall(collateralAddr, 'transferFromMax', [subAccountAddr, userAddr]) as Hash,
        }
        evcCalls.push(transferCall)
      }
    }

    steps.push(helpers.buildEvcBatchStep({
      evcCalls,
      label: usesPermit2 ? 'Permit2 full repay via EVC' : 'Repay via EVC',
    }))

    return { kind: 'full-repay', steps }
  }

  const buildDisableCollateralPlan = async (
    subAccount: string,
    vaultAddress: string,
    borrowVaultAddress?: string,
    enabledCollaterals?: string[],
  ): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const vaultAddr = vaultAddress as Address
    const userAddr = ctx.address.value as Address
    const subAccountAddr = subAccount as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(vaultAddr, vaultTransferFromMaxAbi)
    hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)

    const evcCalls: EVCCall[] = []

    const liabilityAddr = borrowVaultAddress || vaultAddr
    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: liabilityAddr,
      enabledCollaterals,
      removingCollaterals: [vaultAddr],
      userAddr,
    })

    if (subAccountAddr.toLowerCase() !== userAddr.toLowerCase()) {
      const transferCall: EVCCall = {
        targetContract: vaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(vaultAddr, 'transferFromMax', [subAccountAddr, userAddr]) as Hash,
      }
      evcCalls.push(transferCall)
    }

    const disableCollateralCall: EVCCall = {
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccountAddr, vaultAddr]) as Hash,
    }
    evcCalls.push(disableCollateralCall)

    return {
      kind: 'disable-collateral',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Disable collateral via EVC' })],
    }
  }

  /**
   * Repay debt using savings from a different sub-account (same underlying asset, partial).
   * Withdraws from the savings vault on savingsSubAccount, skims into borrow vault on borrowSubAccount,
   * then burns shares to repay debt.
   */
  const buildSavingsRepayPlan = async ({
    savingsVaultAddress,
    borrowVaultAddress,
    amount,
    savingsSubAccount,
    borrowSubAccount,
  }: {
    savingsVaultAddress: string
    borrowVaultAddress: string
    amount: bigint
    savingsSubAccount: string
    borrowSubAccount: string
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const savingsVaultAddr = savingsVaultAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const savingsSubAccountAddr = savingsSubAccount as Address
    const borrowSubAccountAddr = borrowSubAccount as Address

    const sameVault = savingsVaultAddr.toLowerCase() === borrowVaultAddr.toLowerCase()

    const hooks = new SaHooksBuilder()
    if (sameVault) {
      hooks.addContractInterface(savingsVaultAddr, vaultRepayWithSharesAbi)
    }
    else {
      hooks.addContractInterface(savingsVaultAddr, vaultWithdrawAbi)
      hooks.addContractInterface(borrowVaultAddr, [...vaultSkimAbi, ...vaultRepayWithSharesAbi])
    }

    const evcCalls: EVCCall[] = []

    if (sameVault) {
      evcCalls.push({
        targetContract: savingsVaultAddr,
        onBehalfOfAccount: savingsSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(savingsVaultAddr, 'repayWithShares', [amount, borrowSubAccountAddr]) as Hash,
      })
    }
    else {
      // repayWithShares uses amount - 1n to avoid share rounding mismatch
      evcCalls.push({
        targetContract: savingsVaultAddr,
        onBehalfOfAccount: savingsSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(savingsVaultAddr, 'withdraw', [amount, borrowVaultAddr, savingsSubAccountAddr]) as Hash,
      })
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: borrowSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'skim', [amount, borrowSubAccountAddr]) as Hash,
      })
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: borrowSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'repayWithShares', [amount > 0n ? amount - 1n : 0n, borrowSubAccountAddr]) as Hash,
      })
    }

    return {
      kind: 'savings-repay',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Repay with savings via EVC' })],
    }
  }

  /**
   * Full repay using savings from a different sub-account (same underlying asset).
   * Withdraws from savings, repays all debt, disables controller + collateral,
   * returns excess to savings vault, and transfers all positions back to main account.
   */
  const buildSavingsFullRepayPlan = async ({
    savingsVaultAddress,
    borrowVaultAddress,
    amount,
    savingsSubAccount,
    borrowSubAccount,
    enabledCollaterals,
  }: {
    savingsVaultAddress: string
    borrowVaultAddress: string
    amount: bigint
    savingsSubAccount: string
    borrowSubAccount: string
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const savingsVaultAddr = savingsVaultAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const savingsSubAccountAddr = savingsSubAccount as Address
    const borrowSubAccountAddr = borrowSubAccount as Address

    const hasPreExistingBorrowDeposit = await hasPreExistingVaultDeposit(
      ctx,
      borrowVaultAddr,
      borrowSubAccountAddr,
      'buildSavingsFullRepayPlan',
    )

    const sameVault = savingsVaultAddr.toLowerCase() === borrowVaultAddr.toLowerCase()
    const collateralAddresses = enabledCollaterals || []

    const hooks = new SaHooksBuilder()
    if (sameVault) {
      hooks.addContractInterface(savingsVaultAddr, [
        ...vaultRepayWithSharesAbi, ...evcDisableControllerAbi, ...vaultTransferFromMaxAbi,
      ])
    }
    else {
      hooks.addContractInterface(savingsVaultAddr, [...vaultWithdrawAbi, ...vaultSkimAbi, ...vaultTransferFromMaxAbi])
      hooks.addContractInterface(borrowVaultAddr, [...vaultSkimAbi, ...vaultRepayWithSharesAbi, ...evcDisableControllerAbi, ...vaultRedeemAbi])
    }
    hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)
    for (const collateralAddr of collateralAddresses) {
      hooks.addContractInterface(collateralAddr as Address, vaultTransferFromMaxAbi)
    }

    const evcCalls: EVCCall[] = []

    // No Pyth updates needed — batch ends with disableController (no health check)

    if (sameVault) {
      evcCalls.push({
        targetContract: savingsVaultAddr,
        onBehalfOfAccount: savingsSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(savingsVaultAddr, 'repayWithShares', [maxUint256, borrowSubAccountAddr]) as Hash,
      })
    }
    else {
      const adjustedAmount = adjustForInterest(amount)
      evcCalls.push({
        targetContract: savingsVaultAddr,
        onBehalfOfAccount: savingsSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(savingsVaultAddr, 'withdraw', [adjustedAmount, borrowVaultAddr, savingsSubAccountAddr]) as Hash,
      })
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: borrowSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'skim', [adjustedAmount, borrowSubAccountAddr]) as Hash,
      })
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: borrowSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'repayWithShares', [maxUint256, borrowSubAccountAddr]) as Hash,
      })
      // Only sweep the repay cushion when the borrow vault did not already hold shares.
      // Otherwise redeem(max) would also migrate the user's pre-existing borrow-vault deposit.
      if (!hasPreExistingBorrowDeposit) {
        evcCalls.push({
          targetContract: borrowVaultAddr,
          onBehalfOfAccount: borrowSubAccountAddr,
          value: 0n,
          data: hooks.getDataForCall(borrowVaultAddr, 'redeem', [maxUint256, savingsVaultAddr, borrowSubAccountAddr]) as Hash,
        })
        evcCalls.push({
          targetContract: savingsVaultAddr,
          onBehalfOfAccount: savingsSubAccountAddr,
          value: 0n,
          data: hooks.getDataForCall(savingsVaultAddr, 'skim', [maxUint256, savingsSubAccountAddr]) as Hash,
        })
      }
    }

    // Disable controller (no more debt)
    evcCalls.push({
      targetContract: sameVault ? savingsVaultAddr : borrowVaultAddr,
      onBehalfOfAccount: borrowSubAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(sameVault ? savingsVaultAddr : borrowVaultAddr, 'disableController', []) as Hash,
    })

    // Disable collateral (safe after disableController — no health check)
    for (const collateralAddr of collateralAddresses) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [borrowSubAccountAddr, collateralAddr as Address]) as Hash,
      })
    }

    // Transfer collateral shares from borrow sub-account to main account
    const isMainAccount = borrowSubAccountAddr.toLowerCase() === userAddr.toLowerCase()
    if (!isMainAccount) {
      for (const collateralAddr of collateralAddresses) {
        evcCalls.push({
          targetContract: collateralAddr as Address,
          onBehalfOfAccount: borrowSubAccountAddr,
          value: 0n,
          data: hooks.getDataForCall(collateralAddr as Address, 'transferFromMax', [borrowSubAccountAddr, userAddr]) as Hash,
        })
      }
    }

    // Transfer remaining savings shares to main account
    const isSavingsMainAccount = savingsSubAccountAddr.toLowerCase() === userAddr.toLowerCase()
    if (!isSavingsMainAccount) {
      evcCalls.push({
        targetContract: savingsVaultAddr,
        onBehalfOfAccount: savingsSubAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(savingsVaultAddr, 'transferFromMax', [savingsSubAccountAddr, userAddr]) as Hash,
      })
    }

    return {
      kind: 'savings-full-repay',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Full repay with savings via EVC' })],
    }
  }

  return {
    buildRepayPlan,
    buildFullRepayPlan,
    buildDisableCollateralPlan,
    buildSavingsRepayPlan,
    buildSavingsFullRepayPlan,
  }
}
