import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, keccak256, toHex } from 'viem'
import { createAppSafeClients } from '~/features/reviewed-execution/adapters/app-clients'
import { loadPendingSafeReviewedSubmissions } from '~/utils/pending-safe-reviewed-submission'

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
  })

  it('retains a pending calls ID and refuses a duplicate proposal', async () => {
    const provider = { request: vi.fn().mockResolvedValue({ status: 100 }) }
    const { adapter } = createAppSafeClients({
      provider,
      publicClient: { getTransactionReceipt: vi.fn().mockRejectedValue(new Error('not mined')) },
    })
    const reservationId = await adapter.reserveSubmission!(identity('first'))
    await adapter.recordCallsId!(reservationId, hash('calls'))

    await expect(adapter.reserveSubmission!(identity('second'))).rejects.toThrow('still pending')
    expect(loadPendingSafeReviewedSubmissions(storage)).toHaveLength(1)
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
  })
})
