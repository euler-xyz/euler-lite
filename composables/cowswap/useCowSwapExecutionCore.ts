import { computed, ref } from 'vue'
import type { Address, Hex } from 'viem'
import { useConfig, useSendTransaction, useSignTypedData } from '@wagmi/vue'
import { getAccount } from '@wagmi/vue/actions'
import {
  COWSWAP_ORDER_POLL_INTERVAL_MS,
  COWSWAP_ORDER_POLL_MAX_DURATION_MS,
  type CowSwapCancellationMode,
  type CowSwapCancellationStatus,
  type CowSwapExecutionStatus,
  type CowSwapOrderUid,
  type CowSwapPermitCancellation,
  type CowSwapTransactionPlanExecutionProgress,
  type CowSwapTransactionPlanExecutionStatus,
  cancelCowSwapOrder,
  getCowSwapOrderExplorerUrl,
  pollCowSwapOrderStatus,
} from '~/entities/cowswap'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import { INVALIDATE_AFTER_TX } from '~/utils/sdk-query-policy'
import { usePortfolioRefresh } from '~/composables/usePortfolioRefresh'
import { logWarn } from '~/utils/errorHandling'
import { assertNoConflictingPendingSubmission } from '~/utils/pendingSubmissionGate'
import {
  armPendingSubmission,
  createPendingSubmissionAttemptId,
  registerActiveSubmissionAttempt,
  releasePendingSubmission,
  unregisterActiveSubmissionAttempt,
  upgradePendingSubmissionToSubmitted,
  walletNeverAcceptedSubmission,
} from '~/utils/pendingSubmissions'
import { WALLET_CHANGED_SINCE_REVIEW_ERROR, assertWalletExecutionContext } from '~/utils/walletExecutionContext'
import type { ReceiptClientLike } from '~/utils/safeWalletTransactions'

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
  chainId: number
  /** How a *future* user-initiated cancellation should be performed for this flow. */
  cancellationMode: CowSwapCancellationMode
  /** Required when cancellationMode === 'cow-api'. */
  orderbookUrl?: string
  /** Required when cancellationMode === 'cow-api'. */
  settlementContract?: Address
}

const connectorKeyOf = (connector: { id: string, uid: string } | undefined): string | undefined =>
  connector ? `${connector.id}:${connector.uid}` : undefined

export const useCowSwapExecutionCore = () => {
  const { address } = useWagmi()
  const config = useConfig()
  const { signTypedDataAsync } = useSignTypedData()
  const { sendTransactionAsync } = useSendTransaction()
  const { isSpyMode } = useSpyMode()
  const { cowSwapForcedOff } = useCowSwapEligibility()
  const { triggerPortfolioRefresh } = usePortfolioRefresh()

  const status = ref<CowSwapExecutionStatus>('idle')
  const orderUid = ref<CowSwapOrderUid | undefined>()
  const submissionChainId = ref<number | undefined>()
  const submissionOwner = ref<Address | undefined>()
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

  /**
   * Pin every wallet callback handed to the SDK to the context captured at
   * ceremony entry: account, chain, and the connector itself. The SDK awaits
   * between callbacks (approval receipts, inbox preparation, orderbook
   * calls), and a wallet switched during those awaits — including a
   * same-address connector switch, which account/chain checks cannot see —
   * must not receive the next approval or signature request. Each request is
   * also dispatched with the pinned account/chain/connector explicitly, so
   * wagmi cannot silently route it to whatever is current.
   */
  const createPinnedWalletCallbacks = (
    expected: { owner: Address, chainId: number },
    hooks?: { onSignatureOutcome?: (artifactPossible: boolean) => void },
  ) => {
    const entry = getAccount(config)
    const pinnedConnector = entry.connector
    const pinnedConnectorKey = connectorKeyOf(pinnedConnector)
    assertWalletExecutionContext({
      expectedAccount: expected.owner,
      expectedChainId: expected.chainId,
      currentAccount: entry.address,
      currentChainId: entry.chainId,
    })
    if (!pinnedConnector || !pinnedConnectorKey) {
      throw new Error(WALLET_CHANGED_SINCE_REVIEW_ERROR)
    }
    const assertPinnedContext = () => {
      const current = getAccount(config)
      assertWalletExecutionContext({
        expectedAccount: expected.owner,
        expectedChainId: expected.chainId,
        currentAccount: current.address,
        currentChainId: current.chainId,
      })
      if (connectorKeyOf(current.connector) !== pinnedConnectorKey) {
        throw new Error(WALLET_CHANGED_SINCE_REVIEW_ERROR)
      }
    }
    const sendTransaction = ({ to, data, value }: { to: Address, data: Hex, value?: bigint }) => {
      assertPinnedContext()
      return sendTransactionAsync({
        account: expected.owner,
        chainId: expected.chainId,
        connector: pinnedConnector,
        to,
        data,
        value: value ?? 0n,
      })
    }
    const signTypedData = async (typedData: { domain: Record<string, unknown>, types: Record<string, unknown>, primaryType: string, message: Record<string, unknown> }) => {
      assertPinnedContext()
      try {
        const sig = await signTypedDataAsync({
          ...typedData,
          account: expected.owner,
          connector: pinnedConnector,
        } as unknown as Parameters<typeof signTypedDataAsync>[0])
        hooks?.onSignatureOutcome?.(true)
        return sig as Hex
      }
      catch (err) {
        // A proven wallet-side rejection means no signature exists; anything
        // else (dropped connection, timeout) leaves one possible.
        hooks?.onSignatureOutcome?.(!walletNeverAcceptedSubmission(err))
        throw err
      }
    }
    return { sendTransaction, signTypedData }
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
   * Background watcher for a submitted order's quarantine record: once the
   * orderbook reports the order terminal (traded, fulfilled, cancelled, or
   * expired) the record has nothing ambiguous left to guard and is released.
   * If this session never observes a terminal state, the record stays and the
   * pending-submission gate resolves it objectively on the next attempt.
   */
  const releaseWhenOrderTerminal = (
    attempt: { owner: Address, chainId: number, attemptId: string },
    uid: CowSwapOrderUid,
    orderbookUrl?: string,
  ) => {
    void (async () => {
      try {
        const terminal = await pollCowSwapOrderStatus({
          orderUid: uid,
          chainId: attempt.chainId,
          orderbookUrl,
          intervalMs: COWSWAP_ORDER_POLL_INTERVAL_MS,
          timeoutMs: COWSWAP_ORDER_POLL_MAX_DURATION_MS,
        })
        if (terminal.terminal) {
          await releasePendingSubmission('cow-order', attempt.owner, attempt.chainId, { attemptId: attempt.attemptId })
        }
      }
      catch (err) {
        logWarn('cowswap/quarantine-release', err)
      }
    })()
  }

  /**
   * Drive `executeCowSwapTransactionPlan` and surface progress through `status` / `orderUid`.
   * Captures any `permitCancellation` from the plan items so a later EVC-permit hard cancel
   * is available.
   *
   * The whole ceremony runs under an owned quarantine attempt: replay
   * protection is armed before the first approval/signature boundary, the
   * record is upgraded with the order uid the moment one is known, and an
   * ambiguous outcome (a completed or ambiguous signature, or an orderbook
   * submission whose response was lost) keeps the record so no second live
   * order can be created against it. Only a failure that provably left no
   * order artifact — no signature completed, submission never started —
   * releases the reservation, because the approval transactions that may have
   * preceded it are idempotent.
   */
  const executePlan = async (flow: CowSwapPlanFlow): Promise<CowSwapOrderUid> => {
    const userAddress = requireWallet()
    error.value = null
    locallyCancelled.value = false
    cancellationStatus.value = 'none'
    submissionChainId.value = flow.chainId
    submissionOwner.value = userAddress
    cancelMode.value = flow.cancellationMode
    permitCancellation.value = undefined
    cowApiCancellation.value = flow.cancellationMode === 'cow-api'
      ? { chainId: flow.chainId, orderbookUrl: flow.orderbookUrl, settlementContract: flow.settlementContract }
      : undefined

    const attempt = { owner: userAddress, chainId: flow.chainId, attemptId: createPendingSubmissionAttemptId() }
    registerActiveSubmissionAttempt(attempt.attemptId)
    let armed = false
    let signatureArtifactPossible = false
    let submissionStarted = false
    let upgradePromise: ReturnType<typeof upgradePendingSubmissionToSubmitted> | undefined

    const noteOrderUid = (uid: CowSwapOrderUid) => {
      if (upgradePromise) return
      submissionStarted = true
      upgradePromise = upgradePendingSubmissionToSubmitted('cow-order', {
        owner: attempt.owner,
        chainId: attempt.chainId,
        attemptId: attempt.attemptId,
        kind: 'cow-order',
        orderUid: uid,
        orderbookUrl: flow.orderbookUrl,
        completesPlan: true,
      })
      // Awaited explicitly on both the success and failure paths below; this
      // only stops an earlier SDK throw from turning it into an unhandled
      // rejection in the meantime.
      upgradePromise.catch(() => undefined)
    }

    try {
      const sdk = await getEulerSdkFresh()
      const { sendTransaction, signTypedData } = createPinnedWalletCallbacks(
        { owner: userAddress, chainId: flow.chainId },
        { onSignatureOutcome: (artifactPossible) => { signatureArtifactPossible ||= artifactPossible } },
      )
      // Cross-surface quarantine: the CoW executor sends approval
      // transactions and signs the order permit directly through the wallet
      // callbacks below, without passing any plan-executor gate — an
      // unresolved value-moving submission from any flow must block it here,
      // before anything reaches the wallet. CoW execution is EOA-only
      // (assertTransactionsEnabled rejects Safes), so no Safe provider
      // lookup is needed to resolve proposal records.
      await assertNoConflictingPendingSubmission({
        owner: userAddress,
        chainId: flow.chainId,
        provider: sdk.providerService?.getProvider(flow.chainId) as ReceiptClientLike | undefined,
        getSafeWalletProvider: async () => undefined,
      })
      // Atomic check+reserve before the first wallet boundary: an accepted
      // orderbook submission whose response is lost must leave a durable
      // record, or a retry would create a second live order.
      await armPendingSubmission('cow-order', {
        owner: userAddress,
        chainId: flow.chainId,
        completesPlan: true,
        attemptId: attempt.attemptId,
      })
      armed = true
      const result = await sdk.executionService.executeCowSwapTransactionPlan({
        plan: flow.plan,
        chainId: flow.chainId,
        account: userAddress,
        sendTransaction,
        signTypedData,
        onProgress: (progress) => {
          if (progress.status === 'submitOrder') submissionStarted = true
          if (progress.orderUid) noteOrderUid(progress.orderUid)
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

      noteOrderUid(uid)
      // Throws when the order uid could not be durably recorded — the order
      // is live, so that failure must surface instead of reading as success.
      await upgradePromise

      orderUid.value = uid
      status.value = 'submitted'
      releaseWhenOrderTerminal(attempt, uid, flow.orderbookUrl)
      return uid
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      if (upgradePromise) {
        try {
          await upgradePromise
        }
        catch (upgradeErr) {
          logWarn('cowswap/quarantine', upgradeErr)
        }
      }
      if (armed && !submissionStarted && !signatureArtifactPossible) {
        // Provably no order artifact exists: no permit/order signature was
        // produced and the orderbook was never contacted. Any approval
        // transactions already sent are idempotent, so the reservation can be
        // released. Every other failure keeps the record quarantined.
        try {
          await releasePendingSubmission('cow-order', attempt.owner, attempt.chainId, { attemptId: attempt.attemptId })
        }
        catch (releaseErr) {
          logWarn('cowswap/quarantine', releaseErr)
        }
      }
      error.value = wrapped
      status.value = 'idle'
      logWarn('cowswap/execute', wrapped)
      throw wrapped
    }
    finally {
      unregisterActiveSubmissionAttempt(attempt.attemptId)
    }
  }

  // Deliberately not gated on pending submissions: cancellation strictly
  // reduces exposure (it invalidates a standing order) and must stay
  // available while an ambiguous submission is quarantined. Its wallet
  // callbacks are still pinned to the submitting owner's context — a
  // cancellation signed by a switched wallet would be invalid anyway.
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
        const apiCancellation = cowApiCancellation.value
        if (!apiCancellation) throw new Error('CoW API cancellation data not available')

        const { signTypedData } = createPinnedWalletCallbacks({
          owner: submissionOwner.value ?? requireWallet(),
          chainId: apiCancellation.chainId,
        })
        await cancelCowSwapOrder({
          orderUid: uid,
          chainId: apiCancellation.chainId,
          orderbookUrl: apiCancellation.orderbookUrl,
          settlementContract: apiCancellation.settlementContract,
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

        const account = requireWallet()
        const { sendTransaction, signTypedData } = createPinnedWalletCallbacks({
          owner: account,
          chainId: permit.chainId,
        })
        await sdk.executionService.executeCowSwapTransactionPlan({
          plan: cancelPlan,
          chainId: permit.chainId,
          account,
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
    submissionOwner.value = undefined
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
