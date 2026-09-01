import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, keccak256, toHex } from 'viem'
import { createAppSafeClients } from '~/features/reviewed-execution/adapters/app-clients'
import { SafeExecutionAdapter } from '~/features/reviewed-execution/adapters/safe'
import type { DispatchCallbacks } from '~/features/reviewed-execution/adapters/types'
import { clearHashlessPendingSafeReviewedSubmission, loadPendingSafeReviewedSubmissions } from '~/utils/pending-safe-reviewed-submission'
import { withSafeReviewedSubmissionLock } from '~/utils/safe-reviewed-submission-lock'
import { artifactFor, makeReviewedExecution } from './fixtures'

const ACCOUNT = getAddress('0x00000000000000000000000000000000000000a1')
const hash = (value: string) => keccak256(toHex(value))
const identity = (review: string) => ({
  reviewId: hash(review),
  reviewDigest: hash(`${review}:digest`),
  requestDigest: hash(`${review}:request`),
  account: ACCOUNT,
  chainId: 1,
})

const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value) },
  removeItem: (key: string) => { values.delete(key) },
}

describe('Safe app-client durable reservation', () => {
  beforeEach(() => {
    values.clear()
    vi.stubGlobal('window', { localStorage: storage })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('persists the review context before wallet handoff', async () => {
    const { adapter } = createAppSafeClients({
      provider: { request: vi.fn() },
      publicClient: { getTransactionReceipt: vi.fn() },
    })

    const reservationId = await adapter.reserveSubmission!(identity('first'))

    expect(reservationId).toEqual(expect.any(String))
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([
      expect.objectContaining(identity('first')),
    ])
    await adapter.releaseSubmission!(reservationId)
  })

  it('retains a pending calls ID and refuses a duplicate proposal', async () => {
    const provider = { request: vi.fn().mockResolvedValue({ status: 100 }) }
    const { adapter } = createAppSafeClients({
      provider,
      publicClient: { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not mined')) },
    })
    const reservationId = await adapter.reserveSubmission!(identity('first'))
    await adapter.recordCallsId!(reservationId, 'safe-call-batch-123')

    await expect(adapter.reserveSubmission!(identity('second'))).rejects.toThrow('still pending')
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([
      expect.objectContaining({ callsId: 'safe-call-batch-123' }),
    ])
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_getCallsStatus',
      params: ['safe-call-batch-123'],
    })
  })

  it('clears conclusive cancellation before reserving a new review', async () => {
    const provider = { request: vi.fn().mockResolvedValue({ status: 400 }) }
    const { adapter } = createAppSafeClients({
      provider,
      publicClient: { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not mined')) },
    })
    const firstReservation = await adapter.reserveSubmission!(identity('first'))
    await adapter.recordCallsId!(firstReservation, hash('calls'))

    await expect(adapter.reserveSubmission!(identity('second'))).resolves.toEqual(expect.any(String))
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([
      expect.objectContaining(identity('second')),
    ])
    const pending = loadPendingSafeReviewedSubmissions(storage)[0]!
    await adapter.releaseSubmission!(pending.reservationId)
  })

  it('stops after reconciling a successful prior proposal instead of reserving a replacement', async () => {
    const callsId = hash('calls')
    const executionHash = hash('execution')
    const provider = { request: vi.fn().mockResolvedValue({
      status: 200,
      atomic: true,
      receipts: [{ transactionHash: executionHash }],
    }) }
    const onReconciled = vi.fn()
    const { adapter } = createAppSafeClients({
      provider,
      publicClient: {
        getTransactionReceipt: vi.fn(async () => ({
          transactionHash: executionHash,
          status: 'success' as const,
          blockNumber: 123n,
        })),
      },
      onReconciled,
    })
    const firstReservation = await adapter.reserveSubmission!(identity('first'))
    await adapter.recordCallsId!(firstReservation, callsId)

    await expect(adapter.reserveSubmission!(identity('second'))).rejects.toThrow('previous Safe proposal succeeded')
    expect(onReconciled).toHaveBeenCalledOnce()
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([])
  })

  it('keeps a hashless reservation locked while its wallet handoff is live', async () => {
    const { adapter: appClient } = createAppSafeClients({
      provider: { request: vi.fn() },
      publicClient: { getTransactionReceipt: vi.fn() },
    })
    let resolveSend!: (callsId: string) => void
    const sendCalls = vi.fn(() => new Promise<string>((resolve) => {
      resolveSend = resolve
    }))
    const execution = makeReviewedExecution('safe')
    const adapter = new SafeExecutionAdapter({
      ...appClient,
      assertAtomicCapability: async () => {},
      sendCalls,
      waitForExecution: async () => ({
        executionHash: hash('execution'),
        receiptStatus: 'success',
        atomic: true,
      }),
    })
    const callbacks: DispatchCallbacks = {
      assertWalletBinding: async () => {},
      beforeDispatch: async () => {},
      recordExternalId: async () => {},
      markConfirming: async () => {},
      afterConfirmed: async () => {},
    }
    const dispatched = adapter.dispatch(execution, artifactFor(execution), callbacks)
    await vi.waitFor(() => expect(sendCalls).toHaveBeenCalledOnce())
    const reservationId = loadPendingSafeReviewedSubmissions(storage)[0]!.reservationId

    await expect(withSafeReviewedSubmissionLock(() => {
      clearHashlessPendingSafeReviewedSubmission(storage, {
        reservationId,
        account: ACCOUNT,
        chainId: 1,
        confirmedAbsent: true,
      })
    })).rejects.toThrow('Another tab is already managing a Safe submission')

    resolveSend('safe-call-batch-123')
    await expect(dispatched).resolves.toMatchObject({ callsId: 'safe-call-batch-123' })
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([])
  })
})
