import type { Ref, ComputedRef } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep, StepAssetInfo } from '~/utils/stepDecoding'
import type { CowSwapExecutionStatus, CowSwapOrderStatus, CowSwapOrderUid } from '~/entities/cowswap'
import { APPROVE_RESET_REQUIRED_TOKENS } from '~/entities/constants'
import { CowSwapReviewModal } from '#components'

type CowSwapExecutionRef = {
  status: Ref<CowSwapExecutionStatus>
  error: Ref<Error | null>
  explorerUrl: ComputedRef<string | undefined>
  locallyCancelled: Ref<boolean>
  executeAsync: (params: any) => Promise<CowSwapOrderUid>
  cancelOrder: () => Promise<void>
}

type CowSwapOrderStatusRef = {
  orderStatus: Ref<CowSwapOrderStatus | null>
}

/**
 * Build approval DisplaySteps for CoW review modal. When the token requires
 * a reset-to-zero before re-approving (e.g. USDT), prepends a "Reset approval" step.
 */
export const buildApprovalSignSteps = (params: {
  tokenAddress: string
  currentAllowance: bigint
  requiredAmount: bigint
  label: string
  assetInfo: StepAssetInfo
  startIndex: number
}): { steps: DisplayStep[], nextIndex: number } => {
  const steps: DisplayStep[] = []
  let idx = params.startIndex

  if (params.currentAllowance >= params.requiredAmount) {
    return { steps, nextIndex: idx }
  }

  const needsReset = params.currentAllowance > 0n
    && APPROVE_RESET_REQUIRED_TOKENS.has(params.tokenAddress.toLowerCase())

  if (needsReset) {
    steps.push({
      index: idx++,
      label: 'Reset approval',
      isSeparateTx: true,
      assetInfo: params.assetInfo,
    })
  }

  steps.push({
    index: idx++,
    label: params.label,
    isSeparateTx: true,
    assetInfo: params.assetInfo,
  })

  return { steps, nextIndex: idx }
}

export const openCowSwapReviewModal = (
  modal: { open: (component: any, options?: any) => void },
  options: {
    signSteps: DisplayStep[]
    wrapperSteps: DisplayStep[]
    walletWarningsDescription: string
    execution: CowSwapExecutionRef
    orderStatus: CowSwapOrderStatusRef
    executeParams: unknown
    quoteFetchedAt?: number | null
    logPrefix: string
  },
) => {
  modal.open(CowSwapReviewModal, {
    props: {
      signSteps: options.signSteps,
      wrapperSteps: options.wrapperSteps,
      walletWarningsDescription: options.walletWarningsDescription,
      executionStatus: options.execution.status,
      executionError: options.execution.error,
      explorerUrl: options.execution.explorerUrl,
      orderStatus: options.orderStatus.orderStatus,
      locallyCancelled: options.execution.locallyCancelled,
      quoteFetchedAt: options.quoteFetchedAt,
      onConfirm: async () => {
        try {
          await options.execution.executeAsync(options.executeParams)
        }
        catch (e) {
          logWarn(`${options.logPrefix}/execute`, e)
        }
      },
      onCancel: async () => {
        try {
          await options.execution.cancelOrder()
        }
        catch (e) {
          logWarn(`${options.logPrefix}/cancel`, e)
        }
      },
    },
  })
}
