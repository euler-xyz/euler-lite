import { computed, ref } from 'vue'
import { isAddressEqual, type Address, type Hex } from 'viem'
import { useSendTransaction, useSignTypedData } from '@wagmi/vue'
import {
  type CowSwapCancellationMode,
  type CowSwapCancellationStatus,
  type CowSwapExecutionStatus,
  type CowSwapOrderUid,
  type CowSwapPermitCancellation,
  type CowSwapTransactionPlanExecutionProgress,
  type CowSwapTransactionPlanExecutionStatus,
  cancelCowSwapOrder,
  getCowSwapOrderExplorerUrl,
} from '~/entities/cowswap'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { usePortfolioRefresh } from '~/composables/usePortfolioRefresh'
import { logWarn } from '~/utils/errorHandling'
import { assertOperationPolicyChecks, type OperationPolicyCheck } from '~/utils/operationGuardRegistry'

/** SDK progress status → lite UI status used by the review modal. */
const SDK_STATUS_TO_LITE: Record<CowSwapTransactionPlanExecutionStatus, CowSwapExecutionStatus> = {
  approval: 'approving_collateral',
  prepareInbox: 'fetching_inbox',
  signPermit: 'signing_permit',
  signOrder: 'signing_order',
  submitOrder: 'submitting',
  cancelPermit: 'cancelling',
  completed: 'submitted',
}

export type CowSwapPlanFlow = {
  plan: TransactionPlan
  account: Address
  chainId: number
  /** How a *future* user-initiated cancellation should be performed for this flow. */
  cancellationMode: CowSwapCancellationMode
  /** Required when cancellationMode === 'cow-api'. */
  orderbookUrl?: string
  /** Required when cancellationMode === 'cow-api'. */
  settlementContract?: Address
}

export const COW_SWAP_REVIEW_CONTEXT_CHANGED_ERROR
  = 'The connected wallet or network changed after review. Close this review and try again.'

export const useCowSwapExecutionCore = () => {
  const { address, chainId } = useWagmi()
  const { signTypedDataAsync } = useSignTypedData()
  const { sendTransactionAsync } = useSendTransaction()
  const { isSpyMode } = useSpyMode()
  const { cowSwapForcedOff } = useCowSwapEligibility()
  const { triggerPortfolioRefresh } = usePortfolioRefresh()

  const status = ref<CowSwapExecutionStatus>('idle')
  const orderUid = ref<CowSwapOrderUid | undefined>()
  const submissionChainId = ref<number | undefined>()
  const error = ref<Error | null>(null)
  const locallyCancelled = ref(false)
  const cancellationStatus = ref<CowSwapCancellationStatus>('none')
  const cancelMode = ref<CowSwapCancellationMode | undefined>()
  const permitCancellation = ref<CowSwapPermitCancellation | undefined>()
  const cowApiCancellation = ref<{
    chainId: number
    orderbookUrl?: string
    settlementContract?: Address
  } | undefined>()

  const isPending = computed(() => status.value !== 'idle' && status.value !== 'submitted')
  const explorerUrl = computed(() =>
    orderUid.value ? getCowSwapOrderExplorerUrl(orderUid.value) : undefined,
  )

  const assertTransactionsEnabled = () => {
    if (isSpyMode.value) throw new Error('Transactions are disabled in spy mode')
    // Backstop behind the quote-level gate: a Safe cannot produce the ECDSA
    // order signature the CoW executor requires, and failing here is cheaper
    // than failing after the approval transactions have been sent.
    if (cowSwapForcedOff.value) throw new Error('CoW Swap is not available with Safe wallets')
  }

  const requireWallet = () => {
    assertTransactionsEnabled()
    const userAddress = address.value
    if (!userAddress) throw new Error('Wallet not connected')
    return userAddress as Address
  }

  const assertReviewedContext = (flow: CowSwapPlanFlow) => {
    const currentAddress = address.value as Address | undefined
    if (
      !currentAddress
      || !isAddressEqual(currentAddress, flow.account)
      || chainId.value !== flow.chainId
    ) throw new Error(COW_SWAP_REVIEW_CONTEXT_CHANGED_ERROR)
  }

  const sendTransaction = ({ to, data, value }: { to: Address, data: Hex, value?: bigint }) =>
    sendTransactionAsync({ to, data, value: value ?? 0n })

  const signTypedData = async (typedData: { domain: Record<string, unknown>, types: Record<string, unknown>, primaryType: string, message: Record<string, unknown> }) => {
    const sig = await signTypedDataAsync(typedData as unknown as Parameters<typeof signTypedDataAsync>[0])
    return sig as Hex
  }

  const onProgress = (progress: CowSwapTransactionPlanExecutionProgress) => {
    if (progress.status) {
      const mapped = SDK_STATUS_TO_LITE[progress.status]
      if (mapped) status.value = mapped
    }
    if (progress.orderUid) {
      orderUid.value = progress.orderUid
    }
  }

  /**
   * Drive `executeCowSwapTransactionPlan` and surface progress through `status` / `orderUid`.
   * Captures any `permitCancellation` from the plan items so a later EVC-permit hard cancel
   * is available.
   */
  const executePlan = async (
    flow: CowSwapPlanFlow,
    policyChecks: OperationPolicyCheck[] = [],
  ): Promise<CowSwapOrderUid> => {
    const assertCurrentExecutionPolicy = () => {
      assertReviewedContext(flow)
      assertOperationPolicyChecks(policyChecks)
    }
    assertCurrentExecutionPolicy()
    const userAddress = requireWallet()
    error.value = null
    locallyCancelled.value = false
    cancellationStatus.value = 'none'
    submissionChainId.value = flow.chainId
    cancelMode.value = flow.cancellationMode
    permitCancellation.value = undefined
    cowApiCancellation.value = flow.cancellationMode === 'cow-api'
      ? { chainId: flow.chainId, orderbookUrl: flow.orderbookUrl, settlementContract: flow.settlementContract }
      : undefined

    try {
      const sdk = await getEulerSdkFresh()
      assertCurrentExecutionPolicy()
      const result = await sdk.executionService.executeCowSwapTransactionPlan({
        plan: flow.plan,
        chainId: flow.chainId,
        account: userAddress,
        sendTransaction: (transaction) => {
          assertCurrentExecutionPolicy()
          return sendTransaction(transaction)
        },
        signTypedData: (typedData) => {
          assertCurrentExecutionPolicy()
          return signTypedData(typedData)
        },
        onProgress: (progress) => {
          // The SDK emits before each CoW phase, including submitOrder. This
          // closes the interval after signing but before the order is posted.
          // `completed` is different: the SDK emits it only after the orderbook
          // has accepted the order and includes the resulting UID. Never throw
          // after that irreversible boundary or the live order becomes
          // indistinguishable from a failed submission and can be duplicated.
          if (progress.status !== 'completed') assertCurrentExecutionPolicy()
          onProgress(progress)
        },
      })

      for (const r of result.results) {
        if (r.permitCancellation) {
          permitCancellation.value = r.permitCancellation
        }
      }

      const uid = result.orderUids[0]
      if (!uid) throw new Error('CoW order UID missing from execution result')

      orderUid.value = uid
      status.value = 'submitted'
      return uid
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      error.value = wrapped
      status.value = 'idle'
      logWarn('cowswap/execute', wrapped)
      throw wrapped
    }
  }

  const cancelOrder = async (): Promise<void> => {
    assertTransactionsEnabled()
    const uid = orderUid.value
    if (!uid) throw new Error('No order to cancel')

    error.value = null
    const previousStatus = status.value
    const previousCancellationStatus = cancellationStatus.value
    status.value = 'cancelling'
    cancellationStatus.value = 'pending'

    try {
      if (cancelMode.value === 'cow-api') {
        const config = cowApiCancellation.value
        if (!config) throw new Error('CoW API cancellation data not available')

        await cancelCowSwapOrder({
          orderUid: uid,
          chainId: config.chainId,
          orderbookUrl: config.orderbookUrl,
          settlementContract: config.settlementContract,
          signTypedData,
        })
        cancellationStatus.value = 'soft_submitted'
      }
      else {
        const permit = permitCancellation.value
        if (!permit) throw new Error('Permit cancellation data not available')

        const sdk = await getEulerSdkFresh()
        const cancelPlan = sdk.executionService.planCancelClosePositionWithCow({
          chainId: permit.chainId,
          owner: permit.owner,
          nonce: permit.nonce,
          nonceNamespace: permit.nonceNamespace,
          wrapperAddress: permit.wrapperAddress,
        })

        await sdk.executionService.executeCowSwapTransactionPlan({
          plan: cancelPlan,
          chainId: permit.chainId,
          account: requireWallet(),
          sendTransaction,
          signTypedData,
          onProgress,
        })

        // Post-tx side effects (EVC nonce write touched chain state)
        void invalidateSdkQueries([...INVALIDATE_AFTER_TX])
        triggerPortfolioRefresh()
        cancellationStatus.value = 'hard_confirmed'
      }

      locallyCancelled.value = true
      status.value = 'submitted'
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      error.value = wrapped
      status.value = previousStatus
      cancellationStatus.value = previousCancellationStatus
      logWarn('cowswap/cancelOrder', wrapped)
      throw wrapped
    }
  }

  const reset = () => {
    status.value = 'idle'
    orderUid.value = undefined
    submissionChainId.value = undefined
    error.value = null
    locallyCancelled.value = false
    cancellationStatus.value = 'none'
    permitCancellation.value = undefined
    cancelMode.value = undefined
    cowApiCancellation.value = undefined
  }

  return {
    status,
    orderUid,
    submissionChainId,
    error,
    locallyCancelled,
    cancellationStatus,
    cancelMode,
    isPending,
    explorerUrl,
    executePlan,
    cancelOrder,
    reset,
    requireWallet,
  }
}
