import type { Address, Hash, Hex, StateOverride } from 'viem'
import { getAccount, getCapabilities, sendCalls, simulateContract, waitForCallsStatus } from '@wagmi/vue/actions'
import type { OperationsContext, AllowanceHelpers } from './types'
import type { TxPlan } from '~/entities/txPlan'
import { catchToFallback, logWarn } from '~/utils/errorHandling'
import { isNonBlockingSimulationError } from '~/utils/tx-errors'
import { applyOperationGuards } from '~/utils/operationGuardRegistry'
import { extractCallsStatusHash, isUserRejectedRequestError, shouldUseAtomicCalls, toWalletCall } from '~/utils/eip5792'

const OKX_POST_APPROVE_DELAY_MS = 3000

class AtomicCallsSubmittedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AtomicCallsSubmittedError'
  }
}

const isOkxWallet = async (connector?: { id?: string, name?: string, getProvider?: () => Promise<unknown> }) => {
  if (!connector) return false
  const id = connector.id?.toLowerCase() ?? ''
  const name = connector.name?.toLowerCase() ?? ''
  if (id === 'okx' || name.includes('okx')) return true

  // When OKX connects via WalletConnect, the connector itself is generic.
  // The actual wallet name is in the WC session peer metadata.
  if (id === 'walletconnect' && connector.getProvider) {
    try {
      const provider = await connector.getProvider() as { session?: { peer?: { metadata?: { name?: string } } } }
      const peerName = provider?.session?.peer?.metadata?.name?.toLowerCase() ?? ''
      return peerName.includes('okx')
    }
    catch {
      return false
    }
  }

  return false
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

  const refreshAfterExecution = () => {
    triggerPortfolioRefresh()
    setTimeout(triggerPortfolioRefresh, 5000)
  }

  const executeSequentialTxPlan = async (guardedPlan: TxPlan) => {
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
      if (isApproveStep && await isOkxWallet(getAccount(ctx.config).connector)) {
        await new Promise(resolve => setTimeout(resolve, OKX_POST_APPROVE_DELAY_MS))
      }
    }

    refreshAfterExecution()
    return lastHash
  }

  const shouldUseAtomicTxPlan = async (guardedPlan: TxPlan) => {
    const chainId = ctx.chainId.value
    if (!chainId) return false

    const capabilities = await catchToFallback(
      () => getCapabilities(ctx.config, { chainId }),
      undefined,
      'executeTxPlan/getCapabilities',
    )

    return shouldUseAtomicCalls({
      stepCount: guardedPlan.steps.length,
      capabilities,
      chainId,
    })
  }

  const executeAtomicTxPlan = async (guardedPlan: TxPlan): Promise<Hex | string> => {
    const chainId = ctx.chainId.value
    if (!chainId) {
      throw new Error('Chain not connected')
    }

    const result = await sendCalls(ctx.config, {
      chainId,
      calls: guardedPlan.steps.map(toWalletCall),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wagmi call tuple inference cannot follow runtime TxPlan arrays
    } as any)

    const callId = typeof result === 'string'
      ? result
      : (result as { id?: string }).id

    if (!callId) {
      throw new AtomicCallsSubmittedError('sendCalls did not return a call id after submission')
    }

    const status = await catchToFallback(
      () => waitForCallsStatus(ctx.config, { id: callId }),
      undefined,
      'executeTxPlan/waitForCallsStatus',
    )
    if (!status) {
      throw new AtomicCallsSubmittedError('Unable to confirm batched transaction status')
    }
    const statusValue = (status as { status?: unknown, statusCode?: unknown }).status
    const statusCode = (status as { statusCode?: unknown }).statusCode

    if (statusValue === 'failure' || (typeof statusCode === 'number' && statusCode >= 400)) {
      throw new AtomicCallsSubmittedError('Batched transaction failed')
    }

    refreshAfterExecution()
    return extractCallsStatusHash(status) ?? callId
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
    if (await shouldUseAtomicTxPlan(guardedPlan)) {
      try {
        return await executeAtomicTxPlan(guardedPlan)
      }
      catch (err) {
        if (err instanceof AtomicCallsSubmittedError || isUserRejectedRequestError(err)) {
          throw err
        }
        logWarn('executeTxPlan/sendCalls', err)
      }
    }

    return executeSequentialTxPlan(guardedPlan)
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
