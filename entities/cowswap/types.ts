export type {
  CowSwapCompetitionOrderStatusType,
  CowSwapLifecycleOrderStatusType,
  CowSwapOrderPayload,
  CowSwapOrderStatus,
  CowSwapOrderStatusType,
  CowSwapOrderUid,
  CowSwapTerminalOrderStatus,
  CowSwapTypedDataRequest,
} from '@eulerxyz/euler-v2-sdk'

export type CowSwapExecutionStatus
  = | 'idle'
    | 'approving_collateral'
    | 'fetching_inbox'
    | 'signing_permit'
    | 'signing_order'
    | 'submitting'
    | 'cancelling'
    | 'submitted'

export type CowSwapCancellationMode
  = | 'cow-api'
    | 'evc-permit'

export type CowSwapCancellationStatus
  = | 'none'
    | 'pending'
    | 'soft_submitted'
    | 'hard_confirmed'
