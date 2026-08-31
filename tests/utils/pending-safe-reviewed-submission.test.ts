import { beforeEach, describe, expect, it } from 'vitest'
import { getAddress, keccak256, toHex } from 'viem'
import {
  attachPendingSafeCallsId,
  clearHashlessPendingSafeReviewedSubmission,
  clearPendingSafeReviewedSubmission,
  findPendingSafeReviewedSubmission,
  loadPendingSafeReviewedSubmissions,
  reservePendingSafeReviewedSubmission,
} from '~/utils/pending-safe-reviewed-submission'

const ACCOUNT = getAddress('0x00000000000000000000000000000000000000a1')
const hash = (value: string) => keccak256(toHex(value))

const storage = (() => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
  }
})()

const record = () => ({
  reservationId: 'reservation-1',
  reviewId: hash('review'),
  reviewDigest: hash('review-digest'),
  requestDigest: hash('request-digest'),
  account: ACCOUNT,
  chainId: 1,
  createdAt: 1,
})

describe('pending Safe reviewed submission storage', () => {
  beforeEach(storage.clear)

  it('reserves before handoff and binds the returned calls ID to the same context', () => {
    reservePendingSafeReviewedSubmission(storage, record())
    const callsId = 'safe-call-batch-123'
    attachPendingSafeCallsId(storage, 'reservation-1', callsId)

    expect(findPendingSafeReviewedSubmission(storage, ACCOUNT, 1)).toMatchObject({
      ...record(),
      callsId,
    })
  })

  it('rejects another reservation for the same Safe account and chain', () => {
    reservePendingSafeReviewedSubmission(storage, record())

    expect(() => reservePendingSafeReviewedSubmission(storage, {
      ...record(),
      reservationId: 'reservation-2',
      reviewId: hash('other-review'),
    })).toThrow('A previous Safe submission for this account is unresolved')
  })

  it('requires explicit confirmed-absent evidence to clear a hashless handoff', () => {
    reservePendingSafeReviewedSubmission(storage, record())

    expect(() => clearHashlessPendingSafeReviewedSubmission(storage, {
      reservationId: 'reservation-1',
      account: ACCOUNT,
      chainId: 1,
      confirmedAbsent: false,
    })).toThrow('Confirm that Safe contains no proposal')

    clearHashlessPendingSafeReviewedSubmission(storage, {
      reservationId: 'reservation-1',
      account: ACCOUNT,
      chainId: 1,
      confirmedAbsent: true,
    })
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([])
  })

  it('does not allow the manual path to clear a reservation with a calls ID', () => {
    reservePendingSafeReviewedSubmission(storage, record())
    attachPendingSafeCallsId(storage, 'reservation-1', hash('calls-id'))

    expect(() => clearHashlessPendingSafeReviewedSubmission(storage, {
      reservationId: 'reservation-1',
      account: ACCOUNT,
      chainId: 1,
      confirmedAbsent: true,
    })).toThrow('context changed')

    clearPendingSafeReviewedSubmission(storage, 'reservation-1')
    expect(loadPendingSafeReviewedSubmissions(storage)).toEqual([])
  })
})
