import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

const account = () => new Account<IHasVaultAddress>({ chainId: 1, owner: '0x1000000000000000000000000000000000000000', subAccounts: {} })
beforeEach(() => vi.resetModules())
afterEach(() => vi.restoreAllMocks())

describe('planning confirmation generations', () => {
  it('rejects a read spanning a newer confirmation and does not let an older receipt lower the barrier', async () => {
    const { requireFreshPlanningAccount, readFreshPlanningAccount, isPlanningAccountCurrent } = await import('~/utils/planning-account-freshness')
    const first = vi.fn(async () => {})
    requireFreshPlanningAccount(1, 100n, first)
    let complete!: (value: Account<IHasVaultAddress>) => void
    const read = vi.fn(() => new Promise<Account<IHasVaultAddress>>((resolve) => {
      complete = resolve
    }))
    const pending = readFreshPlanningAccount(1, read)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    const second = vi.fn(async () => {})
    requireFreshPlanningAccount(1, 101n, second)
    const ignored = vi.fn(async () => {})
    requireFreshPlanningAccount(1, 99n, ignored)
    const stale = account()
    const rejected = expect(pending).rejects.toThrow('Account changed while refreshing')
    complete(stale)
    await rejected
    expect(isPlanningAccountCurrent(stale)).toBe(false)
    const current = await readFreshPlanningAccount(1, async () => account())
    expect(isPlanningAccountCurrent(current)).toBe(true)
    expect(second).toHaveBeenCalledOnce()
    expect(ignored).not.toHaveBeenCalled()
  })
  it('shares failures during backoff, single-flights the retry, and retains successful catch-up', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { requireFreshPlanningAccount, readFreshPlanningAccount, isPlanningAccountCurrent } = await import('~/utils/planning-account-freshness')
    const wait = vi.fn().mockRejectedValueOnce(new Error('Indexer unavailable')).mockResolvedValue(undefined)
    const read = vi.fn(async () => account())
    requireFreshPlanningAccount(1, 100n, wait)
    await Promise.all([
      expect(readFreshPlanningAccount(1, read)).rejects.toThrow('Indexer unavailable'),
      expect(readFreshPlanningAccount(1, read)).rejects.toThrow('Indexer unavailable'),
    ])
    expect(wait).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()

    clock.mockReturnValue(5_999)
    await expect(readFreshPlanningAccount(1, read)).rejects.toThrow('Indexer unavailable')
    expect(wait).toHaveBeenCalledOnce()
    expect(read).not.toHaveBeenCalled()

    clock.mockReturnValue(6_000)
    const recovered = await Promise.all([readFreshPlanningAccount(1, read), readFreshPlanningAccount(1, read)])
    expect(wait).toHaveBeenCalledTimes(2)
    expect(recovered.every(isPlanningAccountCurrent)).toBe(true)
    clock.mockReturnValue(60_000)
    await readFreshPlanningAccount(1, read)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('gives a newer confirmation its own catch-up attempt during an earlier failure backoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { requireFreshPlanningAccount, readFreshPlanningAccount, isPlanningAccountCurrent } = await import('~/utils/planning-account-freshness')
    const failed = vi.fn().mockRejectedValue(new Error('Indexer unavailable'))
    requireFreshPlanningAccount(1, 100n, failed)
    await expect(readFreshPlanningAccount(1, async () => account())).rejects.toThrow('Indexer unavailable')

    const next = vi.fn(async () => {})
    requireFreshPlanningAccount(1, 101n, next)
    const fresh = await readFreshPlanningAccount(1, async () => account())
    expect(next).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
    expect(isPlanningAccountCurrent(fresh)).toBe(true)
  })
})
