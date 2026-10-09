import { describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { isREULLockClosed, REUL_LOCK_DAY_SECONDS, type REULLock } from '~/entities/reul'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import {
  prepareREULUnlockPlan,
  refreshREULLockReview,
} from '~/components/entities/reward/reulUnlockReview'
import { assertOperationIntent } from '~/features/reviewed-execution/domain/schemas'

const reviewedLock: REULLock = {
  timestamp: 1n,
  amount: 100n,
  unlockableAmount: 80n,
  amountToBeBurned: 20n,
}

describe('prepareREULUnlockPlan', () => {
  const plan = [] as TransactionPlan

  it('reports a build failure without attempting simulation', async () => {
    const buildError = new Error('build failed')
    const simulatePlan = vi.fn(async () => true)

    await expect(prepareREULUnlockPlan(
      reviewedLock,
      async () => { throw buildError },
      simulatePlan,
    )).resolves.toEqual({ status: 'build-failed', error: buildError })
    expect(simulatePlan).not.toHaveBeenCalled()
  })

  it('reports a failed simulation instead of returning a reviewable plan', async () => {
    const simulatePlan = vi.fn(async () => false)

    await expect(prepareREULUnlockPlan(
      reviewedLock,
      async () => plan,
      simulatePlan,
    )).resolves.toEqual({ status: 'simulation-failed' })
    expect(simulatePlan).toHaveBeenCalledWith(plan)
  })
})

describe('isREULLockClosed', () => {
  const lockDay = 1_772_150_400n
  const dayEnd = lockDay + REUL_LOCK_DAY_SECONDS

  it('rejects one second before the end of the lock day', () => {
    expect(isREULLockClosed(lockDay, dayEnd - 1n)).toBe(false)
  })

  it('accepts exactly at and after the end of the lock day', () => {
    expect(isREULLockClosed(lockDay, dayEnd)).toBe(true)
    expect(isREULLockClosed(lockDay, dayEnd + 1n)).toBe(true)
  })

  it('fails closed without chain time', () => {
    expect(isREULLockClosed(lockDay, undefined)).toBe(false)
  })
})

describe('refreshREULLockReview', () => {
  const snapshot = (lock: REULLock | null) => async () => ({ blockNumber: 10n, blockTimestamp: 1_000n, lock })

  it('returns the snapshot lock with its block timestamp', async () => {
    await expect(refreshREULLockReview(reviewedLock, snapshot(reviewedLock)))
      .resolves.toEqual({ status: 'fresh', lock: reviewedLock, blockTimestamp: 1_000n })
  })

  it('accepts a lock whose remainder shrank since the quote', async () => {
    const vested = { ...reviewedLock, unlockableAmount: 90n, amountToBeBurned: 10n }
    await expect(refreshREULLockReview(reviewedLock, snapshot(vested)))
      .resolves.toMatchObject({ status: 'fresh', lock: vested })
  })

  it('rejects a lock that grew since the quote', async () => {
    const grown = { ...reviewedLock, amount: 5_100n, unlockableAmount: 1_020n, amountToBeBurned: 4_080n }
    await expect(refreshREULLockReview(reviewedLock, snapshot(grown)))
      .resolves.toEqual({ status: 'changed' })
  })

  it('reports a removed lock as missing', async () => {
    await expect(refreshREULLockReview(reviewedLock, snapshot(null)))
      .resolves.toEqual({ status: 'missing' })
  })

  it('fails closed when the snapshot cannot be read', async () => {
    await expect(refreshREULLockReview(reviewedLock, async () => null))
      .resolves.toEqual({ status: 'unavailable' })
  })
})

describe('reul-unlock intent schema', () => {
  const account = getAddress('0x1000000000000000000000000000000000000000')
  const reul = getAddress('0xf3e621395fc714B90dA337AA9108771597b4E696')
  const intent = (args: Record<string, unknown>) => ({
    schemaVersion: 1,
    intentId: 'intent-reul-unlock',
    revision: 1,
    kind: 'reul-unlock',
    chainId: 1,
    account,
    subAccounts: [account],
    planner: { name: 'reul-unlock', args },
    constraints: [{ kind: 'remainder-loss', token: reul, maximumLoss: 80n }],
    metadata: { createdAt: 1, source: 'test', operation: 'test' },
  })

  it('requires the quote block timestamp the unlock flag is derived from', () => {
    const args = { lockTimestamps: [1], lockAmounts: [100n], remainderLossMaximum: 80n }
    expect(() => assertOperationIntent(intent({ ...args, quoteBlockTimestamp: 86_401 }))).not.toThrow()
    expect(() => assertOperationIntent(intent(args))).toThrow(/quoteBlockTimestamp/)
    expect(() => assertOperationIntent(intent({ ...args, quoteBlockTimestamp: 0 }))).toThrow(/quoteBlockTimestamp/)
  })
})
