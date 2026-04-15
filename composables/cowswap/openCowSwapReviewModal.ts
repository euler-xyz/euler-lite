import type { Ref, ComputedRef } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep } from '~/utils/stepDecoding'
import type { CowSwapExecutionStatus, CowSwapOrderStatus, CowSwapOrderUid } from '~/entities/cowswap'
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

export const openCowSwapReviewModal = (
  modal: { open: (component: any, options?: any) => void },
  options: {
    signSteps: DisplayStep[]
    wrapperSteps: DisplayStep[]
    walletWarningsDescription: string
    execution: CowSwapExecutionRef
    orderStatus: CowSwapOrderStatusRef
    executeParams: unknown
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
