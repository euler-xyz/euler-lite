import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

const account = () => new Account<IHasVaultAddress>({ chainId: 1, owner: '0x1000000000000000000000000000000000000000', subAccounts: {} })
beforeEach(() => vi.resetModules())

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
})
