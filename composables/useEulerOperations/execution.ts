import type { Address, Hash, Hex, StateOverride } from 'viem'
import { getAccount, simulateContract } from '@wagmi/vue/actions'
import type { OperationsContext, AllowanceHelpers } from './types'
import type { TxPlan } from '~/entities/txPlan'
import { catchToFallback } from '~/utils/errorHandling'
import { isNonBlockingSimulationError } from '~/utils/tx-errors'
import { applyOperationGuards } from '~/utils/operationGuardRegistry'

const OKX_POST_APPROVE_DELAY_MS = 3000

const isOkxWallet = (connector?: { id?: string, name?: string }) => {
  if (!connector) return false
  const id = connector.id?.toLowerCase() ?? ''
  const name = connector.name?.toLowerCase() ?? ''
  return id === 'okx' || name.includes('okx')
}

export const createExecutionHelpers = (ctx: OperationsContext, allowanceHelpers: AllowanceHelpers) => {
  const { triggerPortfolioRefresh } = usePortfolioRefresh()

  const waitForTxReceipt = async (txHash?: Hash) => {
    if (!txHash) {
      return
    }

    const receipt = await ctx.rpcProvider.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted')
    }
  }

  const executeTxPlan = async (plan: TxPlan) => {
    const { isSpyMode } = useSpyMode()
    if (isSpyMode.value) {
      throw new Error('Transactions are disabled in spy mode')
    }

    if (!ctx.address.value) {
      throw new Error('Wallet not connected')
    }

    const guardedPlan = applyOperationGuards(plan)
    let lastHash: Hex | undefined

    for (const step of guardedPlan.steps) {
      /* eslint-disable @typescript-eslint/no-explicit-any -- wagmi writeContractAsync requires ABI-specific generics */
      const txHash = await ctx.writeContractAsync({
        address: step.to,
        abi: step.abi,
        functionName: step.functionName as any,
        args: step.args as any,
        value: step.value ?? 0n,
      })
      /* eslint-enable @typescript-eslint/no-explicit-any */

      lastHash = txHash
      await waitForTxReceipt(txHash)

      // OKX wallet's simulation backend lags behind on-chain state after approvals.
      // Without a delay, the next step's preview shows "unable to decode asset changes".
      const isApproveStep = step.type === 'approve' || step.type === 'permit2-approve'
      if (isApproveStep && isOkxWallet(getAccount(ctx.config).connector)) {
        await new Promise(resolve => setTimeout(resolve, OKX_POST_APPROVE_DELAY_MS))
      }
    }

    triggerPortfolioRefresh()
    setTimeout(triggerPortfolioRefresh, 5000)
    return lastHash
  }

  const simulateTxPlan = async (plan: TxPlan) => {
    if (!ctx.address.value) {
      throw new Error('Wallet not connected')
    }

    const guardedPlan = applyOperationGuards(plan)

    const hasApprovalSteps = guardedPlan.steps.some(step => step.type === 'approve' || step.type === 'permit2-approve')
    const usesPermit2 = guardedPlan.steps.some(step => step.type === 'permit2-approve' || (step.label && step.label.includes('Permit2')))
    const stepsToSimulate = guardedPlan.steps.filter(step => step.type !== 'approve' && step.type !== 'permit2-approve')

    const stateOverride = await catchToFallback(
      async () => {
        const overrides = await allowanceHelpers.buildSimulationStateOverride(guardedPlan, ctx.address.value as Address)
        return overrides.length ? overrides as StateOverride : undefined
      },
      undefined,
      'simulateTxPlan/stateOverrides',
    )

    for (const step of stepsToSimulate) {
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any -- wagmi simulateContract requires ABI-specific generics */
        await simulateContract(ctx.config, {
          account: ctx.address.value as Address,
          address: step.to,
          abi: step.abi,
          functionName: step.functionName as any,
          args: step.args as any,
          value: step.value ?? 0n,
          stateOverride,
        })
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }
      catch (err) {
        const isNonBlocking = (hasApprovalSteps || usesPermit2) && isNonBlockingSimulationError(err)
        if (isNonBlocking) {
          continue
        }
        throw err
      }
    }
  }

  return {
    executeTxPlan,
    simulateTxPlan,
  }
}
