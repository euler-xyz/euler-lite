import { describe, expect, it, vi } from 'vitest'
import { createAddressRefreshCoordinator } from '~/utils/address-refresh-coordinator'

function expectToken(token: false | symbol): asserts token is symbol {
  expect(token).toBeTypeOf('symbol')
}

describe('createAddressRefreshCoordinator', () => {
  it('queues one same-address rerun while a refresh is in flight', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const rerun = vi.fn(async () => {})

    const token = coordinator.begin('0xabc')
    expectToken(token)
    expect(coordinator.begin('0xabc')).toBe(false)
    expect(coordinator.begin('0xabc')).toBe(false)

    await coordinator.finish(token, rerun)

    expect(rerun).toHaveBeenCalledTimes(1)
  })

  it('does not clear a newer different-address refresh when the old one finishes', async () => {
    const onPreempt = vi.fn()
    const coordinator = createAddressRefreshCoordinator(onPreempt)
    const oldRerun = vi.fn(async () => {})
    const currentRerun = vi.fn(async () => {})

    const oldToken = coordinator.begin('0xabc')
    expectToken(oldToken)
    const currentToken = coordinator.begin('0xdef')
    expectToken(currentToken)
    expect(onPreempt).toHaveBeenCalledTimes(1)

    await coordinator.finish(oldToken, oldRerun)
    expect(oldRerun).not.toHaveBeenCalled()

    expect(coordinator.begin('0xdef')).toBe(false)
    await coordinator.finish(currentToken, currentRerun)
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

    expect(coordinator.begin('0xabc')).toBe(false)
    await coordinator.finish(oldToken, oldRerun)
    expect(oldRerun).not.toHaveBeenCalled()

    await coordinator.finish(newToken, newRerun)
    expect(newRerun).toHaveBeenCalledTimes(1)
  })

  it('drops queued work on reset', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const rerun = vi.fn(async () => {})

    const token = coordinator.begin('0xabc')
    expectToken(token)
    expect(coordinator.begin('0xabc')).toBe(false)
    coordinator.reset()

    await coordinator.finish(token, rerun)

    expect(rerun).not.toHaveBeenCalled()
    expect(coordinator.begin('0xabc')).toBeTypeOf('symbol')
  })
})
