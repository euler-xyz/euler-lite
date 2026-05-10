import type { Address, Hash, Hex, StateOverride, TransactionReceipt } from 'viem'
import { getAccount, simulateContract } from '@wagmi/vue/actions'
import type { OperationsContext, AllowanceHelpers } from './types'
import type { TxPlan } from '~/entities/txPlan'
import { catchToFallback, logWarn } from '~/utils/errorHandling'
import { isNonBlockingSimulationError } from '~/utils/tx-errors'
import { applyOperationGuards } from '~/utils/operationGuardRegistry'
import { waitForSubgraphBlock } from '~/utils/subgraph'

const OKX_POST_APPROVE_CONFIRMATION_BLOCKS = 2n
const OKX_POST_APPROVE_MIN_DELAY_MS = 5000
const OKX_POST_APPROVE_BLOCK_TIMEOUT_MS = 15000
const OKX_POST_APPROVE_BLOCK_POLL_MS = 1000

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

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  const waitForTxReceipt = async (txHash?: Hash): Promise<TransactionReceipt | undefined> => {
    if (!txHash) {
      return undefined
    }

    const receipt = await ctx.rpcProvider.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted')
    }
    return receipt
  }

  const waitForPostApprovalConfirmations = async (receipt: TransactionReceipt) => {
    const targetBlock = receipt.blockNumber + OKX_POST_APPROVE_CONFIRMATION_BLOCKS
    const deadline = Date.now() + OKX_POST_APPROVE_BLOCK_TIMEOUT_MS

    while (Date.now() < deadline) {
      try {
        const currentBlock = await ctx.rpcProvider.getBlockNumber()
        if (currentBlock >= targetBlock) {
          return
        }
      }
      catch (err) {
        logWarn('execution/okxPostApproveBlockWait', err)
      }
      await sleep(OKX_POST_APPROVE_BLOCK_POLL_MS)
    }

    logWarn('execution/okxPostApproveBlockWait', 'timed out waiting for post-approval block', {
      data: {
        approvalBlock: receipt.blockNumber.toString(),
        targetBlock: targetBlock.toString(),
      },
    })
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
    const usesOkxWallet = await isOkxWallet(getAccount(ctx.config).connector)
    let lastHash: Hex | undefined
    let lastReceipt: TransactionReceipt | undefined

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
      lastReceipt = await waitForTxReceipt(txHash)

      // OKX wallet's simulation backend lags behind on-chain state after approvals.
      // Give it a couple of blocks plus a small wall-clock floor before prompting
      // the next tx so OKX can validate the allowance in its asset-change preview.
      const isApproveStep = step.type === 'approve' || step.type === 'permit2-approve'
      if (isApproveStep && usesOkxWallet && lastReceipt) {
        await Promise.all([
          sleep(OKX_POST_APPROVE_MIN_DELAY_MS),
          waitForPostApprovalConfirmations(lastReceipt),
        ])
      }
    }

    // Immediate trigger covers wallet balances and best-effort positions; the
    // delayed trigger fires once the subgraph has indexed the tx's block so
    // the user lands on /portfolio with positions reflecting the new state.
    triggerPortfolioRefresh()
    if (lastReceipt && ctx.SUBGRAPH_URL) {
      void waitForSubgraphBlock(ctx.SUBGRAPH_URL, lastReceipt.blockNumber)
        .then((caughtUp) => {
          if (caughtUp) triggerPortfolioRefresh()
        })
        .catch(err => logWarn('execution/subgraphPoll', err))
    }
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
