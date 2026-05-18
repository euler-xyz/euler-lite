import { INTEREST_ADJUSTMENT_BPS, BPS_BASE } from '~/entities/tuning-constants'
import type { OperationsContext, Permit2Helpers, AllowanceHelpers, OperationHelpers } from './types'
import { type Address, getAddress, type Abi, maxUint256, encodeFunctionData, type Hash } from 'viem'
import type { AssetAllowances, EVault } from '@eulerxyz/euler-v2-sdk'
import type { TxStep } from '~/entities/txPlan'
import { erc20ABI } from '~/entities/euler/abis'
import { EVC_ABI } from '~/abis/evc'
import { wethDepositAbi } from '~/abis/weth'
import { erc20TransferAbi } from '~/abis/erc20'
import type { EVCCall } from '~/utils/evc-converter'
import { buildPythUpdateCalls, buildPythUpdateCallsFromFeeds, collectPythFeedsForHealthCheck, sumCallValues } from '~/utils/pyth'
import { logWarn } from '~/utils/errorHandling'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { APPROVE_RESET_REQUIRED_TOKENS } from '~/entities/constants'

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
        return ctx.registryGetVault(getAddress(addr)) as EVault | undefined
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
      const liabilityVault = ctx.registryGetVault(getAddress(liabilityVaultAddress)) as EVault | undefined
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
    directApproval?: boolean
  }) => {
    const { assetAddr, spenderAddr, userAddr, amount, includePermit2Call: includePermit2 = true, directApproval = false } = params
    const fetchWalletAllowances = async (): Promise<AssetAllowances | undefined> => {
      if (!ctx.chainId.value) return undefined

      try {
        const sdk = await getEulerSdk()
        const walletFetch = await sdk.walletService.fetchWallet(ctx.chainId.value, userAddr, [
          { asset: assetAddr, spenders: [spenderAddr] },
        ])
        if (walletFetch.errors.length) {
          logWarn('prepareTokenApproval/walletService', 'wallet service returned diagnostics', {
            data: {
              chainId: ctx.chainId.value,
              asset: assetAddr,
              spender: spenderAddr,
              owner: userAddr,
              errors: walletFetch.errors,
            },
          })
        }
        return walletFetch.result.getAllowances(assetAddr, spenderAddr)
      }
      catch (err) {
        logWarn('prepareTokenApproval/walletService', err)
        return undefined
      }
    }

    const walletAllowances = await fetchWalletAllowances()
    const currentAllowance = walletAllowances?.assetForVault
      ?? await allowance.checkAllowance(assetAddr, spenderAddr, userAddr)
    const permit2Address = permit2.resolvePermit2Address()
    const canUsePermit2 = !directApproval && !!ctx.chainId.value && !!permit2Address && ctx.permit2Enabled.value

    const steps: TxStep[] = []
    let permitCall: EVCCall | undefined
    const usesPermit2 = canUsePermit2 && currentAllowance < amount
    const needsApproveReset = (currentAmount: bigint) =>
      currentAmount > 0n && APPROVE_RESET_REQUIRED_TOKENS.has(assetAddr.toLowerCase())

    if (usesPermit2 && permit2Address) {
      const permit2Allowance = walletAllowances?.assetForPermit2
        ?? await allowance.checkAllowance(assetAddr, permit2Address, userAddr)
      const needsPermit2Approval = permit2Allowance < amount
      if (needsPermit2Approval) {
        if (needsApproveReset(permit2Allowance)) {
          steps.push({
            type: 'approve',
            label: 'Reset approval',
            to: assetAddr,
            abi: erc20ABI as Abi,
            functionName: 'approve',
            args: [permit2Address, 0n] as const,
            value: 0n,
          })
        }
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
        const knownPermit2Allowance = walletAllowances
          ? {
              amount: walletAllowances.assetForVaultInPermit2,
              expiration: BigInt(walletAllowances.permit2ExpirationTime),
              nonce: BigInt(walletAllowances.permit2Nonce),
            }
          : undefined
        permitCall = await permit2.buildPermit2Call(assetAddr, spenderAddr, amount, userAddr, permit2Address, knownPermit2Allowance)
      }
    }
    else if (currentAllowance < amount) {
      if (needsApproveReset(currentAllowance)) {
        steps.push({
          type: 'approve',
          label: 'Reset approval',
          to: assetAddr,
          abi: erc20ABI as Abi,
          functionName: 'approve',
          args: [spenderAddr, 0n] as const,
          value: 0n,
        })
      }
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
