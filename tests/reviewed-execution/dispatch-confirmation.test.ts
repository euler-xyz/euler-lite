import { describe, expect, it, vi } from 'vitest'
import type { Hash, TransactionReceipt } from 'viem'
import { EoaExecutionAdapter } from '~/features/reviewed-execution/adapters/eoa'
import { SafeExecutionAdapter } from '~/features/reviewed-execution/adapters/safe'
import type { DispatchCallbacks } from '~/features/reviewed-execution/adapters/types'
import { artifactFor, makeReviewedExecution, materializedExecutorFor, TEST_EVC } from './fixtures'

const HASH = `0x${'01'.repeat(32)}` as Hash

const callbacks = (): DispatchCallbacks => ({
  assertWalletBinding: vi.fn(async () => {}),
  beforeDispatch: vi.fn(async () => {}),
  recordExternalId: vi.fn(async () => {}),
  markConfirming: vi.fn(async () => {}),
  afterConfirmed: vi.fn(async () => {}),
})

describe('reviewed execution confirmation metadata', () => {
  it('returns the final EOA receipt block', async () => {
    const execution = makeReviewedExecution()
    const adapter = new EoaExecutionAdapter(
      { sendTransaction: async () => HASH },
      materializedExecutorFor(async hash => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      } as TransactionReceipt)),
      TEST_EVC,
    )

    const result = await adapter.dispatch(execution, artifactFor(execution), callbacks())

    expect(result).toMatchObject({
      transactionHashes: [HASH],
      confirmedBlockNumber: 123n,
    })
  })

  it('returns the confirmed Safe execution block', async () => {
    const execution = makeReviewedExecution('safe')
    const events: string[] = []
    const adapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      reserveSubmission: async (identity) => {
        expect(identity).toMatchObject({
          reviewId: execution.reviewId,
          reviewDigest: execution.reviewDigest,
          requestDigest: execution.requestDigest,
          account: execution.requestSet.wallet.account,
          chainId: execution.requestSet.wallet.chainId,
        })
        events.push('reserved')
        return 'reservation-1'
      },
      sendCalls: async () => {
        events.push('sent')
        return 'safe-call-batch-123'
      },
      recordCallsId: async (reservationId, callsId) => {
        expect([reservationId, callsId]).toEqual(['reservation-1', 'safe-call-batch-123'])
        events.push('recorded')
      },
      releaseSubmission: async () => {
        events.push('released')
      },
      clearSubmission: async (reservationId) => {
        expect(reservationId).toBe('reservation-1')
        events.push('cleared')
      },
      waitForExecution: async () => ({
        executionHash: HASH,
        receiptStatus: 'success',
        confirmedBlockNumber: 456n,
        atomic: true,
      }),
    })

    const result = await adapter.dispatch(execution, artifactFor(execution), callbacks())

    expect(result).toMatchObject({
      transactionHashes: [HASH],
      executionHash: HASH,
      confirmedBlockNumber: 456n,
      atomic: true,
    })
    expect(events).toEqual(['reserved', 'sent', 'recorded', 'cleared'])
  })

  it('retains the durable reservation when Safe status is unknown', async () => {
    const execution = makeReviewedExecution('safe')
    const clearSubmission = vi.fn()
    const adapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      reserveSubmission: async () => 'reservation-1',
      sendCalls: async () => HASH,
      recordCallsId: async () => {},
      releaseSubmission: async () => {},
      clearSubmission,
      waitForExecution: async () => { throw new Error('gateway unavailable') },
    })

    await expect(adapter.dispatch(execution, artifactFor(execution), callbacks())).rejects.toThrow(/status is unknown/i)
    expect(clearSubmission).not.toHaveBeenCalled()
  })

  it('revalidates after a deferred reservation and blocks wallet-context drift before handoff', async () => {
    const execution = makeReviewedExecution('safe')
    let resolveReservation!: (reservationId: string) => void
    const reservation = new Promise<string>((resolve) => {
      resolveReservation = resolve
    })
    const reserveSubmission = vi.fn(async () => reservation)
    const sendCalls = vi.fn(async () => 'safe-call-batch-123')
    const clearSubmission = vi.fn(async () => {})
    const adapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      reserveSubmission,
      sendCalls,
      recordCallsId: async () => {},
      releaseSubmission: async () => {},
      clearSubmission,
      waitForExecution: async () => ({
        executionHash: HASH,
        receiptStatus: 'success',
        atomic: true,
      }),
    })
    let bindingIsCurrent = true
    const dispatchCallbacks = callbacks()
    dispatchCallbacks.beforeDispatch = vi.fn(async () => {
      if (!bindingIsCurrent) throw new Error('wallet context changed')
    })

    const dispatched = adapter.dispatch(execution, artifactFor(execution), dispatchCallbacks)
    await vi.waitFor(() => expect(reserveSubmission).toHaveBeenCalledOnce())
    bindingIsCurrent = false
    resolveReservation('reservation-1')

    await expect(dispatched).rejects.toThrow('wallet context changed')
    expect(dispatchCallbacks.beforeDispatch).toHaveBeenCalledTimes(2)
    expect(clearSubmission).toHaveBeenCalledWith('reservation-1')
    expect(sendCalls).not.toHaveBeenCalled()
  })
})
