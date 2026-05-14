import type { Address, Abi, Hash } from 'viem'
import { encodeFunctionData, getAddress, maxUint256 } from 'viem'
import type { OperationsContext, Permit2Helpers, AllowanceHelpers, OperationHelpers } from './types'
import { erc20ABI } from '~/entities/euler/abis'
import { erc20TransferAbi } from '~/abis/erc20'
import { wethDepositAbi } from '~/abis/weth'
import { EVC_ABI } from '~/abis/evc'
import type { EVCCall } from '~/utils/evc-converter'
import type { TxStep } from '~/entities/txPlan'
import { buildPythUpdateCalls, buildPythUpdateCallsFromFeeds, collectPythFeedsForHealthCheck, sumCallValues } from '~/utils/pyth'
import { logWarn } from '~/utils/errorHandling'
import { INTEREST_ADJUSTMENT_BPS, BPS_BASE } from '~/entities/tuning-constants'
import type { Vault } from '~/entities/vault'
import { assertOperationNotBlocked } from '~/utils/operationGuardRegistry'

/** Pad amount by 0.01% to cover interest accrual between plan build and tx execution */
export const adjustForInterest = (amount: bigint) => (amount * INTEREST_ADJUSTMENT_BPS) / BPS_BASE

export const createOperationHelpers = (ctx: OperationsContext, permit2: Permit2Helpers, allowance: AllowanceHelpers): OperationHelpers => {
  const resolveEffectiveCollaterals = (
    enabledCollaterals?: string[],
    adding?: string[],
    removing?: string[],
  ): string[] => {
    const set = new Set<string>()
    for (const addr of enabledCollaterals || []) {
      set.add(allowance.normalizeAddress(addr))
    }
    for (const addr of adding || []) {
      set.add(allowance.normalizeAddress(addr))
    }
    for (const addr of removing || []) {
      set.delete(allowance.normalizeAddress(addr))
    }
    return [...set]
  }

  const preparePythUpdates = async (vaultAddresses: string[], sender: Address) => {
    try {
      const vaults = vaultAddresses.map((addr) => {
        return ctx.registryGetVault(getAddress(addr)) as Vault | undefined
      })
      return await buildPythUpdateCalls(vaults, ctx.rpcUrl, ctx.PYTH_HERMES_URL, sender)
    }
    catch (err) {
      logWarn('preparePythUpdates', err)
      return { calls: [], totalFee: 0n }
    }
  }

  const preparePythUpdatesForHealthCheck = async (
    liabilityVaultAddress: string,
    collateralVaultAddresses: string[],
    sender: Address,
  ) => {
    try {
      const liabilityVault = ctx.registryGetVault(getAddress(liabilityVaultAddress)) as Vault | undefined
      if (!liabilityVault) {
        logWarn('preparePythUpdatesForHealthCheck', `liability vault not found: ${liabilityVaultAddress}`)
        return { calls: [], totalFee: 0n }
      }

      const feeds = collectPythFeedsForHealthCheck(liabilityVault, collateralVaultAddresses)
      return await buildPythUpdateCallsFromFeeds(feeds, ctx.rpcUrl, ctx.PYTH_HERMES_URL, sender)
    }
    catch (err) {
      logWarn('preparePythUpdatesForHealthCheck', err)
      return { calls: [], totalFee: 0n }
    }
  }

  const prepareTokenApproval = async (params: {
    assetAddr: Address
    spenderAddr: Address
    userAddr: Address
    amount: bigint
    includePermit2Call?: boolean
  }) => {
    const { assetAddr, spenderAddr, userAddr, amount, includePermit2Call: includePermit2 = true } = params
    const currentAllowance = await allowance.checkAllowance(assetAddr, spenderAddr, userAddr)
    const permit2Address = permit2.resolvePermit2Address()
    const canUsePermit2 = !!ctx.chainId.value && !!permit2Address && ctx.permit2Enabled.value

    const steps: TxStep[] = []
    let permitCall: EVCCall | undefined
    const usesPermit2 = canUsePermit2 && currentAllowance < amount

    if (usesPermit2 && permit2Address) {
      const permit2Allowance = await allowance.checkAllowance(assetAddr, permit2Address, userAddr)
      const needsPermit2Approval = permit2Allowance < amount
      if (needsPermit2Approval) {
        steps.push({
          type: 'permit2-approve',
          label: 'Approve token for Permit2',
          to: assetAddr,
          abi: erc20ABI as Abi,
          functionName: 'approve',
          args: [permit2Address, maxUint256] as const,
          value: 0n,
        })
      }

      if (includePermit2) {
        assertOperationNotBlocked()
        permitCall = await permit2.buildPermit2Call(assetAddr, spenderAddr, amount, userAddr, permit2Address)
      }
    }
    else if (currentAllowance < amount) {
      steps.push({
        type: 'approve',
        label: 'Approve asset for vault',
        to: assetAddr,
        abi: erc20ABI as Abi,
        functionName: 'approve',
        args: [spenderAddr, amount] as const,
        value: 0n,
      })
    }

    return { steps, permitCall, usesPermit2 }
  }

  const injectPythHealthCheckUpdates = async (params: {
    evcCalls: EVCCall[]
    liabilityVaultAddr: string
    enabledCollaterals?: string[]
    additionalCollaterals?: string[]
    removingCollaterals?: string[]
    userAddr: Address
  }) => {
    const effectiveCollaterals = resolveEffectiveCollaterals(
      params.enabledCollaterals,
      params.additionalCollaterals,
      params.removingCollaterals,
    )
    const { calls: pythCalls } = await preparePythUpdatesForHealthCheck(
      params.liabilityVaultAddr,
      effectiveCollaterals,
      params.userAddr,
    )
    if (pythCalls.length) {
      params.evcCalls.unshift(...pythCalls as EVCCall[])
    }
  }

  const buildEvcBatchStep = (params: {
    evcCalls: EVCCall[]
    label: string
  }): TxStep => {
    const evcAddress = ctx.eulerCoreAddresses.value!.evc as Address
    const totalValue = sumCallValues(params.evcCalls)
    return {
      type: 'evc-batch',
      label: params.label,
      to: evcAddress,
      abi: EVC_ABI,
      functionName: 'batch',
      args: [params.evcCalls as never],
      value: totalValue,
    }
  }

  const buildNativeWrapCalls = (params: {
    wrappedTokenAddress: Address
    amount: bigint
    userAddr: Address
  }): EVCCall[] => [
    {
      targetContract: params.wrappedTokenAddress,
      onBehalfOfAccount: params.userAddr,
      value: params.amount,
      data: encodeFunctionData({ abi: wethDepositAbi, functionName: 'deposit' }) as Hash,
    },
    {
      targetContract: params.wrappedTokenAddress,
      onBehalfOfAccount: params.userAddr,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: 'transfer',
        args: [params.userAddr, params.amount],
      }) as Hash,
    },
  ]

  return {
    prepareTokenApproval,
    injectPythHealthCheckUpdates,
    buildEvcBatchStep,
    buildNativeWrapCalls,
    resolveEffectiveCollaterals,
    adjustForInterest,
    preparePythUpdates,
    preparePythUpdatesForHealthCheck,
  }
}
