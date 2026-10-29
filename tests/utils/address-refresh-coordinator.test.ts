import { describe, expect, it, vi } from 'vitest'
import { createAddressRefreshCoordinator } from '~/utils/address-refresh-coordinator'

function expectToken(token: unknown): asserts token is symbol {
  expect(token).toBeTypeOf('symbol')
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('createAddressRefreshCoordinator', () => {
  it('coalesces same-address callers and waits until their queued rerun finishes', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const pending = deferred()
    const rerun = vi.fn(() => pending.promise)

    const token = coordinator.begin('0xabc')
    expectToken(token)
    const queued = coordinator.begin('0xabc')
    expect(queued).toBeInstanceOf(Promise)
    expect(coordinator.begin('0xabc')).toBe(queued)
    const onSettled = vi.fn()
    const waiting = Promise.resolve(queued).then(onSettled)
    await Promise.resolve()
    expect(onSettled).not.toHaveBeenCalled()

    const finished = coordinator.finish(token, rerun)
    expect(rerun).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(onSettled).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([finished, waiting])
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('settles preempted waiters without clearing the newer different-address refresh', async () => {
    const onPreempt = vi.fn()
    const coordinator = createAddressRefreshCoordinator(onPreempt)
    const oldRerun = vi.fn(async () => {})
    const currentRerun = vi.fn(async () => {})

    const oldToken = coordinator.begin('0xabc')
    expectToken(oldToken)
    const oldQueued = coordinator.begin('0xabc')
    expect(oldQueued).toBeInstanceOf(Promise)
    const currentToken = coordinator.begin('0xdef')
    expectToken(currentToken)
    expect(onPreempt).toHaveBeenCalledTimes(1)
    await oldQueued

    const queued = coordinator.begin('0xdef')
    expect(queued).toBeInstanceOf(Promise)
    await coordinator.finish(oldToken, oldRerun)
    expect(oldRerun).not.toHaveBeenCalled()
    expect(coordinator.begin('0xdef')).toBe(queued)

    await coordinator.finish(currentToken, currentRerun)
    await queued
    expect(currentRerun).toHaveBeenCalledTimes(1)
  })

  it('does not let an old same-address refresh evict a newer owner after an address switch', async () => {
    const onPreempt = vi.fn()
    const coordinator = createAddressRefreshCoordinator(onPreempt)
    const oldRerun = vi.fn(async () => {})
    const newRerun = vi.fn(async () => {})

    const oldToken = coordinator.begin('0xabc')
    expectToken(oldToken)
    const middleToken = coordinator.begin('0xdef')
    expectToken(middleToken)
    const newToken = coordinator.begin('0xabc')
    expectToken(newToken)
    expect(onPreempt).toHaveBeenCalledTimes(2)

    const queued = coordinator.begin('0xabc')
    expect(queued).toBeInstanceOf(Promise)
    await coordinator.finish(oldToken, oldRerun)
    expect(oldRerun).not.toHaveBeenCalled()

    await coordinator.finish(newToken, newRerun)
    await queued
    expect(newRerun).toHaveBeenCalledTimes(1)
  })

  it('settles queued callers and drops their work on reset', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const rerun = vi.fn(async () => {})

    const token = coordinator.begin('0xabc')
    expectToken(token)
    const queued = coordinator.begin('0xabc')
    expect(queued).toBeInstanceOf(Promise)
    coordinator.reset()
    await queued
    await coordinator.finish(token, rerun)

    expect(rerun).not.toHaveBeenCalled()
    expect(coordinator.begin('0xabc')).toBeTypeOf('symbol')
  })

  it.each(['reset', 'preempt'] as const)('releases all running queued generations on %s without disturbing newer work', async (cancellation) => {
    const coordinator = createAddressRefreshCoordinator()
    const firstToken = coordinator.begin('0xabc')
    expectToken(firstToken)
    const firstQueued = coordinator.begin('0xabc')
    const firstSettled = vi.fn()
    const firstWaiting = Promise.resolve(firstQueued).then(firstSettled)
    let secondToken!: symbol
    const secondDone = deferred()
    const firstFinished = coordinator.finish(firstToken, async () => {
      const token = coordinator.begin('0xabc')
      expectToken(token)
      secondToken = token
      await secondDone.promise
    })
    const secondQueued = coordinator.begin('0xabc')
    const secondSettled = vi.fn()
    const secondWaiting = Promise.resolve(secondQueued).then(secondSettled)
    const thirdDone = deferred()
    const secondFinished = coordinator.finish(secondToken, async () => {
      expectToken(coordinator.begin('0xabc'))
      await thirdDone.promise
    })
    await Promise.resolve()
    expect(firstSettled).not.toHaveBeenCalled()
    expect(secondSettled).not.toHaveBeenCalled()

    if (cancellation === 'reset') coordinator.reset()
    const newAddress = cancellation === 'reset' ? '0xabc' : '0xdef'
    const newToken = coordinator.begin(newAddress)
    expectToken(newToken)
    await Promise.resolve()
    expect(firstSettled).toHaveBeenCalledTimes(1)
    expect(secondSettled).toHaveBeenCalledTimes(1)

    const newQueued = coordinator.begin(newAddress)
    const newSettled = vi.fn()
    const newWaiting = Promise.resolve(newQueued).then(newSettled)
    thirdDone.resolve()
    await secondFinished
    secondDone.resolve()
    await Promise.all([firstFinished, firstWaiting, secondWaiting])
    expect(newSettled).not.toHaveBeenCalled()
    expect(coordinator.begin(newAddress)).toBe(newQueued)

    await coordinator.finish(newToken, async () => {})
    await newWaiting
    expect(newSettled).toHaveBeenCalledTimes(1)
  })

  it('settles queued callers even if the rerun fails', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const token = coordinator.begin('0xabc')
    expectToken(token)
    const queued = coordinator.begin('0xabc')
    expect(queued).toBeInstanceOf(Promise)

    await expect(coordinator.finish(token, async () => {
      throw new Error('refresh failed')
    })).rejects.toThrow('refresh failed')
    await expect(queued).resolves.toBeUndefined()
    expect(coordinator.begin('0xabc')).toBeTypeOf('symbol')
  })
})
