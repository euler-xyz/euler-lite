import type { Address, Hash } from 'viem'
import { maxUint256 } from 'viem'
import { adjustForInterest } from '../helpers'
import { hasPreExistingVaultDeposit } from '../preExistingDeposit'
import type { OperationsContext, OperationHelpers } from '../types'
import { evcDisableCollateralAbi, evcDisableControllerAbi, evcEnableCollateralAbi, evcEnableControllerAbi } from '~/abis/evc'
import { vaultBorrowAbi, vaultRedeemAbi, vaultRepayWithSharesAbi, vaultSkimAbi, vaultTransferFromMaxAbi, vaultWithdrawAbi } from '~/abis/vault'
import { SaHooksBuilder } from '~/entities/saHooksSDK'
import type { EVCCall } from '~/utils/evc-converter'
import type { TxPlan } from '~/entities/txPlan'

export const createSameAssetSwapBuilders = (
  ctx: OperationsContext,
  helpers: OperationHelpers,
) => {
  const buildSameAssetSwapPlan = async ({
    fromVaultAddress,
    toVaultAddress,
    amount,
    isMax = false,
    maxShares,
    subAccount,
    enableCollateral = false,
    disableCollateral = false,
    liabilityVault,
    enabledCollaterals,
  }: {
    fromVaultAddress: string
    toVaultAddress: string
    amount: bigint
    isMax?: boolean
    maxShares?: bigint
    subAccount?: string
    enableCollateral?: boolean
    disableCollateral?: boolean
    liabilityVault?: string
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const fromVaultAddr = fromVaultAddress as Address
    const toVaultAddr = toVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const accountAddr = subAccount ? (subAccount as Address) : userAddr

    const hooks = new SaHooksBuilder()
    if (isMax) {
      hooks.addContractInterface(fromVaultAddr, vaultRedeemAbi)
    }
    else {
      hooks.addContractInterface(fromVaultAddr, vaultWithdrawAbi)
    }
    hooks.addContractInterface(toVaultAddr, vaultSkimAbi)

    const evcAbis = [
      ...(enableCollateral ? evcEnableCollateralAbi : []),
      ...(disableCollateral ? evcDisableCollateralAbi : []),
    ]
    if (evcAbis.length) {
      hooks.addContractInterface(evcAddress, evcAbis)
    }

    const evcCalls: EVCCall[] = []

    // Pyth updates for health check (when there's a liability vault)
    if (liabilityVault) {
      await helpers.injectPythHealthCheckUpdates({
        evcCalls,
        liabilityVaultAddr: liabilityVault,
        enabledCollaterals,
        additionalCollaterals: enableCollateral ? [toVaultAddr] : [],
        removingCollaterals: disableCollateral ? [fromVaultAddr] : [],
        userAddr,
      })
    }

    // Withdraw from old vault (sends underlying to new vault address)
    if (isMax && maxShares !== undefined) {
      evcCalls.push({
        targetContract: fromVaultAddr,
        onBehalfOfAccount: accountAddr,
        value: 0n,
        data: hooks.getDataForCall(fromVaultAddr, 'redeem', [maxShares, toVaultAddr, accountAddr]) as Hash,
      })
    }
    else if (isMax) {
      evcCalls.push({
        targetContract: fromVaultAddr,
        onBehalfOfAccount: accountAddr,
        value: 0n,
        data: hooks.getDataForCall(fromVaultAddr, 'redeem', [maxUint256, toVaultAddr, accountAddr]) as Hash,
      })
    }
    else {
      evcCalls.push({
        targetContract: fromVaultAddr,
        onBehalfOfAccount: accountAddr,
        value: 0n,
        data: hooks.getDataForCall(fromVaultAddr, 'withdraw', [amount, toVaultAddr, accountAddr]) as Hash,
      })
    }

    // Skim on new vault
    evcCalls.push({
      targetContract: toVaultAddr,
      onBehalfOfAccount: accountAddr,
      value: 0n,
      data: hooks.getDataForCall(toVaultAddr, 'skim', [amount, accountAddr]) as Hash,
    })

    if (enableCollateral) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'enableCollateral', [accountAddr, toVaultAddr]) as Hash,
      })
    }

    if (disableCollateral) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [accountAddr, fromVaultAddr]) as Hash,
      })
    }

    return {
      kind: 'same-asset-swap',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Transfer via EVC' })],
    }
  }

  const buildSameAssetRepayPlan = async ({
    collateralVaultAddress,
    borrowVaultAddress,
    amount,
    subAccount,
    enabledCollaterals,
  }: {
    collateralVaultAddress: string
    borrowVaultAddress: string
    amount: bigint
    subAccount: string
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const collateralVaultAddr = collateralVaultAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const subAccountAddr = subAccount as Address

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(collateralVaultAddr, vaultWithdrawAbi)
    hooks.addContractInterface(borrowVaultAddr, [...vaultSkimAbi, ...vaultRepayWithSharesAbi])

    const evcCalls: EVCCall[] = []

    // Pyth updates for health check
    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: borrowVaultAddress,
      enabledCollaterals,
      userAddr,
    })

    // Withdraw from collateral vault, send underlying to borrow vault
    evcCalls.push({
      targetContract: collateralVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(collateralVaultAddr, 'withdraw', [amount, borrowVaultAddr, subAccountAddr]) as Hash,
    })

    // Skim on borrow vault
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'skim', [amount, subAccountAddr]) as Hash,
    })

    // Burn shares to repay debt — use amount - 1n to avoid share rounding mismatch
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'repayWithShares', [amount > 0n ? amount - 1n : 0n, subAccountAddr]) as Hash,
    })

    return {
      kind: 'same-asset-repay',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Repay with collateral via EVC' })],
    }
  }

  const buildSameAssetFullRepayPlan = async ({
    collateralVaultAddress,
    borrowVaultAddress,
    amount,
    subAccount,
    enabledCollaterals,
  }: {
    collateralVaultAddress: string
    borrowVaultAddress: string
    amount: bigint
    subAccount: string
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const collateralVaultAddr = collateralVaultAddress as Address
    const borrowVaultAddr = borrowVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const subAccountAddr = subAccount as Address

    const hasPreExistingBorrowDeposit = await hasPreExistingVaultDeposit(
      ctx,
      borrowVaultAddr,
      subAccountAddr,
      'buildSameAssetFullRepayPlan',
    )

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(collateralVaultAddr, [...vaultWithdrawAbi, ...vaultSkimAbi, ...vaultTransferFromMaxAbi])
    hooks.addContractInterface(borrowVaultAddr, [...vaultSkimAbi, ...vaultRepayWithSharesAbi, ...evcDisableControllerAbi, ...vaultRedeemAbi])
    hooks.addContractInterface(evcAddress, evcDisableCollateralAbi)

    const evcCalls: EVCCall[] = []

    // No Pyth updates needed — batch ends with disableController (no health check)

    // 1. Withdraw from collateral vault (slightly more than debt for interest)
    const adjustedAmount = adjustForInterest(amount)
    evcCalls.push({
      targetContract: collateralVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(collateralVaultAddr, 'withdraw', [adjustedAmount, borrowVaultAddr, subAccountAddr]) as Hash,
    })

    // 2. Skim on borrow vault
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'skim', [adjustedAmount, subAccountAddr]) as Hash,
    })

    // 3. Repay ALL debt with shares
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'repayWithShares', [maxUint256, subAccountAddr]) as Hash,
    })

    // 4. Disable controller
    evcCalls.push({
      targetContract: borrowVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(borrowVaultAddr, 'disableController', []) as Hash,
    })

    // 5. Disable collateral
    const collateralAddresses = enabledCollaterals || [collateralVaultAddress]
    for (const collateralAddr of collateralAddresses) {
      evcCalls.push({
        targetContract: evcAddress,
        onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: hooks.getDataForCall(evcAddress, 'disableCollateral', [subAccountAddr, collateralAddr as Address]) as Hash,
      })
    }

    // Only sweep the repay cushion when the borrow vault did not already hold shares.
    // Otherwise redeem(max) would also migrate the user's pre-existing borrow-vault deposit.
    if (!hasPreExistingBorrowDeposit) {
      evcCalls.push({
        targetContract: borrowVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(borrowVaultAddr, 'redeem', [maxUint256, collateralVaultAddr, subAccountAddr]) as Hash,
      })

      evcCalls.push({
        targetContract: collateralVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(collateralVaultAddr, 'skim', [maxUint256, subAccountAddr]) as Hash,
      })
    }

    // Transfer remaining collateral back to main account.
    const isMainAccount = subAccountAddr.toLowerCase() === userAddr.toLowerCase()
    if (!isMainAccount) {
      evcCalls.push({
        targetContract: collateralVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(collateralVaultAddr, 'transferFromMax', [subAccountAddr, userAddr]) as Hash,
      })
    }

    return {
      kind: 'same-asset-full-repay',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Full repay with collateral via EVC' })],
    }
  }

  const buildSameAssetDebtSwapPlan = async ({
    oldVaultAddress,
    newVaultAddress,
    amount,
    subAccount,
    enabledCollaterals,
  }: {
    oldVaultAddress: string
    newVaultAddress: string
    amount: bigint
    subAccount: string
    enabledCollaterals?: string[]
  }): Promise<TxPlan> => {
    if (!ctx.address.value || !ctx.eulerCoreAddresses.value || !ctx.eulerPeripheryAddresses.value) {
      throw new Error('Wallet not connected or addresses not available')
    }

    const oldVaultAddr = oldVaultAddress as Address
    const newVaultAddr = newVaultAddress as Address
    const userAddr = ctx.address.value as Address
    const evcAddress = ctx.eulerCoreAddresses.value.evc as Address
    const subAccountAddr = subAccount as Address

    const hasPreExistingOldVaultDeposit = await hasPreExistingVaultDeposit(
      ctx,
      oldVaultAddr,
      subAccountAddr,
      'buildSameAssetDebtSwapPlan',
    )

    const hooks = new SaHooksBuilder()
    hooks.addContractInterface(newVaultAddr, [...vaultBorrowAbi, ...vaultSkimAbi, ...vaultTransferFromMaxAbi])
    hooks.addContractInterface(oldVaultAddr, [...vaultSkimAbi, ...vaultRepayWithSharesAbi, ...evcDisableControllerAbi, ...vaultRedeemAbi])
    hooks.addContractInterface(evcAddress, evcEnableControllerAbi)

    const evcCalls: EVCCall[] = []

    // Pyth updates — batch ends with active debt in new vault, so health check IS needed
    await helpers.injectPythHealthCheckUpdates({
      evcCalls,
      liabilityVaultAddr: newVaultAddress,
      enabledCollaterals,
      userAddr,
    })

    // 1. Enable new vault as controller
    evcCalls.push({
      targetContract: evcAddress,
      onBehalfOfAccount: '0x0000000000000000000000000000000000000000' as Address,
      value: 0n,
      data: hooks.getDataForCall(evcAddress, 'enableController', [subAccountAddr, newVaultAddr]) as Hash,
    })

    // 2. Borrow from new vault, send tokens to old vault
    const adjustedAmount = adjustForInterest(amount)
    evcCalls.push({
      targetContract: newVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(newVaultAddr, 'borrow', [adjustedAmount, oldVaultAddr]) as Hash,
    })

    // 3. Skim on old vault
    evcCalls.push({
      targetContract: oldVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(oldVaultAddr, 'skim', [adjustedAmount, subAccountAddr]) as Hash,
    })

    // 4. Repay ALL debt on old vault
    evcCalls.push({
      targetContract: oldVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(oldVaultAddr, 'repayWithShares', [maxUint256, subAccountAddr]) as Hash,
    })

    // 5. Disable controller on old vault
    evcCalls.push({
      targetContract: oldVaultAddr,
      onBehalfOfAccount: subAccountAddr,
      value: 0n,
      data: hooks.getDataForCall(oldVaultAddr, 'disableController', []) as Hash,
    })

    // Only sweep the migration cushion when the old vault did not already hold shares.
    // Otherwise redeem(max) would also migrate the user's pre-existing old-vault deposit.
    if (!hasPreExistingOldVaultDeposit) {
      evcCalls.push({
        targetContract: oldVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(oldVaultAddr, 'redeem', [maxUint256, newVaultAddr, subAccountAddr]) as Hash,
      })

      evcCalls.push({
        targetContract: newVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(newVaultAddr, 'skim', [maxUint256, subAccountAddr]) as Hash,
      })
    }

    // Transfer all new vault shares from sub-account to main account.
    const isMainAccount = subAccountAddr.toLowerCase() === userAddr.toLowerCase()
    if (!isMainAccount) {
      evcCalls.push({
        targetContract: newVaultAddr,
        onBehalfOfAccount: subAccountAddr,
        value: 0n,
        data: hooks.getDataForCall(newVaultAddr, 'transferFromMax', [subAccountAddr, userAddr]) as Hash,
      })
    }

    return {
      kind: 'same-asset-debt-swap',
      steps: [helpers.buildEvcBatchStep({ evcCalls, label: 'Debt swap via EVC' })],
    }
  }

  return {
    buildSameAssetSwapPlan,
    buildSameAssetRepayPlan,
    buildSameAssetFullRepayPlan,
    buildSameAssetDebtSwapPlan,
  }
}
