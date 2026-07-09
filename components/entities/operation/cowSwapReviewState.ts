import type { ToastVariant } from '~/components/ui/toast.types'
import type {
  CowSwapCancellationMode,
  CowSwapCancellationStatus,
  CowSwapExecutionStatus,
  CowSwapOrderStatus,
} from '~/entities/cowswap'

type CowSwapReviewStateParams = {
  executionStatus: CowSwapExecutionStatus
  orderStatus: CowSwapOrderStatus | null
  locallyCancelled: boolean
  cancellationMode: CowSwapCancellationMode | undefined
  cancellationStatus: CowSwapCancellationStatus
  isLocallyCancelling: boolean
}

const getTerminalOrderStatusLabel = (orderStatus: CowSwapOrderStatus | null): string | undefined => {
  switch (orderStatus?.type) {
    case 'traded': return 'Order filled'
    case 'fulfilled': return 'Order fulfilled'
    case 'cancelled': return 'Order cancelled'
    case 'expired': return 'Order expired'
    default: return undefined
  }
}

export const resolveCowSwapReviewState = (params: CowSwapReviewStateParams) => {
  const isCancelPending = params.executionStatus === 'cancelling'
    || params.cancellationStatus === 'pending'
    || params.isLocallyCancelling
  const isHardCancelled = params.cancellationStatus === 'hard_confirmed'
  const isSoftCancellationSubmitted = params.cancellationStatus === 'soft_submitted'
    || (params.locallyCancelled && params.cancellationMode === 'cow-api')
  const terminalLabel = getTerminalOrderStatusLabel(params.orderStatus)

  let orderStatusLabel: string
  if (isCancelPending) {
    orderStatusLabel = 'Cancelling order'
  }
  else if (terminalLabel) {
    orderStatusLabel = terminalLabel
  }
  else if (isHardCancelled) {
    orderStatusLabel = 'Order settlement blocked'
  }
  else if (isSoftCancellationSubmitted) {
    orderStatusLabel = 'Cancellation submitted — checking order status...'
  }
  else if (!params.orderStatus) {
    orderStatusLabel = 'Waiting for solver...'
  }
  else {
    switch (params.orderStatus.type) {
      case 'open':
        orderStatusLabel = 'Order open — waiting for solver...'
        break
      case 'active':
        orderStatusLabel = 'Solver found — executing...'
        break
      case 'solved':
        orderStatusLabel = 'Order solved — settling...'
        break
      case 'executing':
        orderStatusLabel = 'Executing on-chain...'
        break
      default: orderStatusLabel = 'Waiting for solver...'
    }
  }

  let orderStatusDescription: string | undefined
  if (isCancelPending) {
    orderStatusDescription = params.cancellationMode === 'evc-permit'
      ? 'Confirm the EVC nonce transaction in your wallet.'
      : 'We are cancelling the swap order.'
  }
  else if (isHardCancelled && !params.orderStatus?.terminal) {
    orderStatusDescription = 'Settlement is blocked by EVC nonce invalidation. CoW Explorer may show open until expiry.'
  }
  else if (isSoftCancellationSubmitted && !params.orderStatus?.terminal) {
    orderStatusDescription = 'The cancellation request was submitted. CoW cancellation is soft, so the order may still fill until CoW reports it cancelled.'
  }

  const isCancellationComplete = isHardCancelled || isSoftCancellationSubmitted
  const canCancelOrder = !params.orderStatus?.terminal && !isCancellationComplete
  const showSoftCancelWarning = isSoftCancellationSubmitted
    && !params.orderStatus?.terminal
    && params.cancellationMode === 'cow-api'
  const orderStatusVariant: ToastVariant = params.orderStatus?.type === 'expired' ? 'warning' : 'info'
  const hasUnresolvedSubmittedOrder = (params.executionStatus === 'submitted' || isCancelPending)
    && !params.orderStatus?.terminal
    && !isHardCancelled

  return {
    isCancelPending,
    isHardCancelled,
    isSoftCancellationSubmitted,
    orderStatusLabel,
    orderStatusDescription,
    orderStatusVariant,
    canCancelOrder,
    showSoftCancelWarning,
    hasUnresolvedSubmittedOrder,
  }
}
