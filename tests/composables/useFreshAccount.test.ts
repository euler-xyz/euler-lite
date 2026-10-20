import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef, type EffectScope } from 'vue'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

const sdk = vi.hoisted(() => ({ fast: vi.fn(), fresh: vi.fn() }))
vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({ accountService: { fetchAccount: sdk.fast } }),
  getEulerSdkFresh: async () => ({ accountService: { fetchAccount: sdk.fresh } }),
}))
vi.mock('~/composables/useTxBatch', () => ({ activeLayerAccountRef: { value: undefined } }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const owner = '0x1000000000000000000000000000000000000000' as const
const makeAccount = (chainId = 1) => new Account<IHasVaultAddress>({ chainId, owner, subAccounts: {}, populated: {} })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const result = (account: Account<IHasVaultAddress>) => ({ result: account, errors: [] })
let scope: EffectScope

beforeEach(() => {
  vi.resetModules()
  sdk.fast.mockReset()
  sdk.fresh.mockReset()
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

const setup = async () => {
  const counter = ref(0)
  const chain = ref(1)
  const portfolio = shallowRef({ account: makeAccount() })
  vi.stubGlobal('useEffectiveAddress', () => ({ effectiveAddress: ref(owner) }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: chain }))
  vi.stubGlobal('usePortfolioRefresh', () => ({ portfolioRefreshCounter: counter }))
  vi.stubGlobal('useEulerAccount', () => ({ portfolio }))
  const { useFreshAccount } = await import('~/composables/useFreshAccount')
  const loader = scope.run(useFreshAccount)!
  vi.stubGlobal('useFreshAccount', () => loader)
  const { usePlanAccount } = await import('~/composables/usePlanAccount')
  const plan = scope.run(usePlanAccount)!
  const freshness = await import('~/utils/planning-account-freshness')
  const prefetch = await import('~/composables/batchPrefetchState')
  return { loader, plan, counter, chain, portfolio, ...freshness, ...prefetch }
}

describe('planning account after a confirmed transaction', () => {
  it('keeps the normal fast-then-fresh race before any confirmation', async () => {
    const fast = makeAccount()
    const fresh = makeAccount()
    const pending = deferred<ReturnType<typeof result>>()
    sdk.fast.mockResolvedValue(result(fast))
    sdk.fresh.mockReturnValue(pending.promise)
    const app = await setup()
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fast))
    pending.resolve(result(fresh))
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fresh))
  })

  it('rejects stale V3 winning while indexing and fresh reads lag, including portfolio and batch fallbacks', async () => {
    const stale = makeAccount()
    const fresh = makeAccount()
    const pending = deferred<ReturnType<typeof result>>()
    const indexed = deferred<undefined>()
    sdk.fast.mockResolvedValue(result(stale))
    sdk.fresh.mockResolvedValueOnce(result(stale)).mockReturnValue(pending.promise)
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.setBatchPrefetchedBaseAccount(stale)
    app.requireFreshPlanningAccount(1, 123n, () => indexed.promise)
    expect(app.plan.account.value).toBeUndefined()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()
    expect(app.getBatchPrefetchedBaseAccount()).toBeUndefined()
    app.counter.value++
    await nextTick()
    await vi.waitFor(() => expect(sdk.fast).toHaveBeenCalledTimes(2))
    expect(sdk.fresh).toHaveBeenCalledTimes(1)
    expect(app.plan.account.value).toBeUndefined()
    indexed.resolve(undefined)
    await vi.waitFor(() => expect(sdk.fresh).toHaveBeenCalledTimes(2))
    expect(app.plan.account.value).toBeUndefined()
    pending.resolve(result(fresh))
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fresh))
    expect(app.getBatchPrefetchedPlanningAccount()).toBe(fresh)
    expect(app.getBatchPrefetchedBaseAccount()).toBeUndefined()
  })

  it('keeps stale V3 unavailable when the fresh read fails, and recovers on retry', async () => {
    const stale = makeAccount()
    sdk.fast.mockResolvedValue(result(stale))
    sdk.fresh.mockResolvedValueOnce(result(stale)).mockRejectedValueOnce(new Error('RPC unavailable'))
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.requireFreshPlanningAccount(1, 123n, async () => {})
    app.counter.value++
    await vi.waitFor(() => expect(sdk.fresh).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    expect(app.loader.account.value).toBeUndefined()
    expect(app.plan.account.value).toBeUndefined()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()
    const fresh = makeAccount()
    sdk.fresh.mockResolvedValue(result(fresh))
    app.loader.refresh()
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fresh))
  })

  it('does not fetch or adopt an account after catch-up fails, and retries catch-up later', async () => {
    const stale = makeAccount()
    sdk.fast.mockResolvedValue(result(stale))
    sdk.fresh.mockResolvedValue(result(stale))
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    const wait = vi.fn().mockRejectedValueOnce(new Error('Indexer still behind')).mockResolvedValue(undefined)
    app.requireFreshPlanningAccount(1, 123n, wait)
    app.counter.value++
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    expect(sdk.fresh).toHaveBeenCalledOnce()
    expect(app.plan.account.value).toBeUndefined()
    const fresh = makeAccount()
    sdk.fresh.mockResolvedValue(result(fresh))
    app.loader.refresh()
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fresh))
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('rejects a fresh read already in flight when confirmation arrives', async () => {
    const old = deferred<ReturnType<typeof result>>()
    sdk.fast.mockResolvedValue(result(makeAccount()))
    sdk.fresh.mockReturnValue(old.promise)
    const app = await setup()
    await vi.waitFor(() => expect(sdk.fresh).toHaveBeenCalledOnce())
    app.requireFreshPlanningAccount(1, 123n, async () => {})
    old.resolve(result(makeAccount()))
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    expect(app.plan.account.value).toBeUndefined()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()
  })

  it('keeps confirmations isolated by chain and invalidates derived accounts on the next confirmation', async () => {
    sdk.fast.mockResolvedValue(result(makeAccount()))
    sdk.fresh.mockResolvedValue(result(makeAccount()))
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.requireFreshPlanningAccount(2, 123n, async () => {})
    expect(app.plan.account.value).toBeDefined()
    app.requireFreshPlanningAccount(1, 123n, async () => {})
    const current = await app.readFreshPlanningAccount(1, async () => makeAccount())
    const layer = makeAccount()
    app.inheritPlanningAccountFreshness(current, layer)
    expect(app.isPlanningAccountCurrent(layer)).toBe(true)
    app.requireFreshPlanningAccount(1, 124n, async () => {})
    expect(app.isPlanningAccountCurrent(current)).toBe(false)
    expect(app.isPlanningAccountCurrent(layer)).toBe(false)
  })
})
