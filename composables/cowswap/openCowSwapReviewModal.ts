import type { Component, ComputedRef, Ref } from 'vue'
import type { Address } from 'viem'
import { requiresZeroApprovalReset } from '@eulerxyz/euler-v2-sdk'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep, StepAssetInfo } from '~/utils/stepDecoding'
import type { ModalData } from '~/components/ui/composables/useModal'
import type {
  CowSwapCancellationMode,
  CowSwapCancellationStatus,
  CowSwapExecutionStatus,
  CowSwapOrderStatus,
  CowSwapOrderUid,
} from '~/entities/cowswap'
import { CowSwapReviewModal } from '#components'
import {
  assertOperationPolicyChecks,
  captureOperationPolicyChecks,
  type OperationPolicyCheck,
} from '~/utils/operationGuardRegistry'

type CowSwapExecutionRef<TExecuteParams> = {
  status: Ref<CowSwapExecutionStatus>
  error: Ref<Error | null>
  explorerUrl: ComputedRef<string | undefined>
  locallyCancelled: Ref<boolean>
  cancellationMode: Ref<CowSwapCancellationMode | undefined>
  cancellationStatus: Ref<CowSwapCancellationStatus>
  executeAsync: (params: TExecuteParams, policyChecks?: OperationPolicyCheck[]) => Promise<CowSwapOrderUid>
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
  chainId: number
  tokenAddress: Address
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
    && requiresZeroApprovalReset(params.chainId, params.tokenAddress)

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

export const openCowSwapReviewModal = <TExecuteParams>(
  modal: { open: (component: Component, options?: ModalData) => void },
  options: {
    signSteps: DisplayStep[]
    wrapperSteps: DisplayStep[]
    walletWarningsDescription: string
    execution: CowSwapExecutionRef<TExecuteParams>
    orderStatus: CowSwapOrderStatusRef
    executeParams: TExecuteParams
    quoteFetchedAt?: number | null
    logPrefix: string
  },
) => {
  const policyChecks = captureOperationPolicyChecks()
  modal.open(CowSwapReviewModal, {
    isNotClosable: true,
    closeOnBackdropWhenAllowed: true,
    props: {
      signSteps: options.signSteps,
      wrapperSteps: options.wrapperSteps,
      walletWarningsDescription: options.walletWarningsDescription,
      executionStatus: options.execution.status,
      executionError: options.execution.error,
      explorerUrl: options.execution.explorerUrl,
      orderStatus: options.orderStatus.orderStatus,
      locallyCancelled: options.execution.locallyCancelled,
      cancellationMode: options.execution.cancellationMode,
      cancellationStatus: options.execution.cancellationStatus,
      quoteFetchedAt: options.quoteFetchedAt,
      onConfirm: async () => {
        try {
          assertOperationPolicyChecks(policyChecks)
          await options.execution.executeAsync(options.executeParams, policyChecks)
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
