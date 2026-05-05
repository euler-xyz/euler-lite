import { describe, expect, it, vi } from 'vitest'
import { createAddressRefreshCoordinator } from '~/utils/address-refresh-coordinator'

describe('createAddressRefreshCoordinator', () => {
  it('queues one same-address rerun while a refresh is in flight', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const rerun = vi.fn(async () => {})

    expect(coordinator.begin('0xabc')).toBe(true)
    expect(coordinator.begin('0xabc')).toBe(false)
    expect(coordinator.begin('0xabc')).toBe(false)

    await coordinator.finish('0xabc', rerun)

    expect(rerun).toHaveBeenCalledTimes(1)
  })

  it('does not clear a newer different-address refresh when the old one finishes', async () => {
    const onPreempt = vi.fn()
    const coordinator = createAddressRefreshCoordinator(onPreempt)
    const oldRerun = vi.fn(async () => {})
    const currentRerun = vi.fn(async () => {})

    expect(coordinator.begin('0xabc')).toBe(true)
    expect(coordinator.begin('0xdef')).toBe(true)
    expect(onPreempt).toHaveBeenCalledTimes(1)

    await coordinator.finish('0xabc', oldRerun)
    expect(oldRerun).not.toHaveBeenCalled()

    expect(coordinator.begin('0xdef')).toBe(false)
    await coordinator.finish('0xdef', currentRerun)
    expect(currentRerun).toHaveBeenCalledTimes(1)
  })

  it('drops queued work on reset', async () => {
    const coordinator = createAddressRefreshCoordinator()
    const rerun = vi.fn(async () => {})

    expect(coordinator.begin('0xabc')).toBe(true)
    expect(coordinator.begin('0xabc')).toBe(false)
    coordinator.reset()

    await coordinator.finish('0xabc', rerun)

    expect(rerun).not.toHaveBeenCalled()
    expect(coordinator.begin('0xabc')).toBe(true)
  })
})
