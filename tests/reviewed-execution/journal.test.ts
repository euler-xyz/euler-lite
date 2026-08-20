import { describe, expect, it } from 'vitest'
import { MemorySubmissionJournal, requestVectorDigest } from '~/features/reviewed-execution/persistence/journal'
import { walletLaneKey } from '~/features/reviewed-execution/persistence/locks'
import { makeReviewedExecution } from './fixtures'

describe('durable reviewed execution journal contract', () => {
  it('atomically fences a wallet lane and rejects stale compare-and-swap writes', async () => {
    const execution = makeReviewedExecution()
    const journal = new MemorySubmissionJournal()
    await journal.putReviewedExecution(execution)
    const laneKey = walletLaneKey(execution.requestSet.wallet.account, execution.requestSet.wallet.chainId)
    const attempt = await journal.reserveAttempt({ execution, attemptId: 'attempt-1', reservationId: 'reservation-1', laneKey, requestVectorDigest: requestVectorDigest(execution), now: 10 })

    await expect(journal.reserveAttempt({ execution, attemptId: 'attempt-2', reservationId: 'reservation-2', laneKey, requestVectorDigest: requestVectorDigest(execution), now: 11 }))
      .rejects.toThrow(/already reserved/)
    const next = await journal.transitionAttempt({ expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to: 'revalidating', now: 12 })
    await expect(journal.transitionAttempt({ expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to: 'finalized', now: 13 }))
      .rejects.toThrow(/compare-and-swap/)
    expect(next.version).toBe(2)
    expect((await journal.listAttemptEvents(attempt.attemptId)).map(event => event.to)).toEqual(['reserved', 'revalidating'])
  })

  it('reads back every reservation field and keeps external identifiers monotonic', async () => {
    const execution = makeReviewedExecution()
    const journal = new MemorySubmissionJournal()
    await journal.putReviewedExecution(execution)
    const laneKey = walletLaneKey(execution.requestSet.wallet.account, execution.requestSet.wallet.chainId)
    let attempt = await journal.reserveAttempt({ execution, attemptId: 'attempt-1', reservationId: 'reservation-1', laneKey, requestVectorDigest: requestVectorDigest(execution), now: 10 })
    await expect(journal.verifyReservation({
      attemptId: attempt.attemptId, reservationId: 'wrong', reviewId: execution.reviewId,
      requestDigest: execution.requestDigest, account: attempt.account, chainId: attempt.chainId,
      laneKey, requestVectorDigest: requestVectorDigest(execution), version: attempt.version, fence: attempt.fence,
    })).rejects.toThrow(/does not match/)

    attempt = await journal.transitionAttempt({ expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to: 'revalidating', now: 10 })
    attempt = await journal.transitionAttempt({ expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to: 'finalized', now: 10 })
    attempt = await journal.transitionAttempt({ expected: { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, to: 'dispatching', now: 10 })
    attempt = await journal.recordExternalArtifact(
      { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence },
      { kind: 'calls-id', value: 'safe-calls-id', observedAt: 11 },
    )
    attempt = await journal.recordExternalArtifact(
      { attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence },
      { kind: 'calls-id', value: 'safe-calls-id', observedAt: 12 },
    )
    expect(attempt.externalIds).toEqual([{ kind: 'calls-id', value: 'safe-calls-id' }])
    expect(await journal.listExternalArtifacts(attempt.attemptId)).toHaveLength(1)
  })

  it('never releases ambiguous or otherwise non-terminal attempts', async () => {
    const execution = makeReviewedExecution()
    const journal = new MemorySubmissionJournal()
    await journal.putReviewedExecution(execution)
    const attempt = await journal.reserveAttempt({
      execution, attemptId: 'attempt-1', reservationId: 'reservation-1',
      laneKey: walletLaneKey(execution.requestSet.wallet.account, execution.requestSet.wallet.chainId),
      requestVectorDigest: requestVectorDigest(execution), now: 10,
    })
    await expect(journal.releaseLane({ attemptId: attempt.attemptId, version: attempt.version, fence: attempt.fence }, 11))
      .rejects.toThrow(/non-terminal/)
  })
})
