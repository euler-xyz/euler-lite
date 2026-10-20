import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, shallowRef, type EffectScope } from 'vue'
import { Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'

const sdk = vi.hoisted(() => ({ fast: vi.fn(), fresh: vi.fn() }))
vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({ accountService: { fetchAccount: sdk.fast } }),
  getEulerSdkFresh: async () => ({ accountService: { fetchAccount: sdk.fresh } }),
}))
vi.mock('~/composables/useTxBatch', async () => ({ activeLayerAccountRef: (await import('vue')).shallowRef() }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const owner = '0x1000000000000000000000000000000000000000' as const
const otherOwner = '0x2000000000000000000000000000000000000000' as const
const makeAccount = (chainId = 1, accountOwner: Address = owner) => new Account<IHasVaultAddress>({ chainId, owner: accountOwner, subAccounts: {}, populated: {} })
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const setup = async (initialOwner: Address = owner) => {
  const counter = ref(0)
  const chain = ref(1)
  const portfolio = shallowRef({ account: makeAccount(1, initialOwner) })
  const effectiveAddress = ref<string | undefined>(initialOwner)
  const { activeLayerAccountRef } = await import('~/composables/useTxBatch')
  activeLayerAccountRef.value = undefined
  vi.stubGlobal('useEffectiveAddress', () => ({ effectiveAddress }))
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
  return { loader, plan, counter, chain, portfolio, effectiveAddress, activeLayerAccountRef, ...freshness, ...prefetch }
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

  it('deduplicates failed catch-up during backoff and recovers on an explicit refresh after expiry', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
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
    clock.mockReturnValue(5_999)
    app.loader.refresh()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    expect(wait).toHaveBeenCalledOnce()
    expect(sdk.fresh).toHaveBeenCalledOnce()
    expect(app.plan.account.value).toBeUndefined()
    const fresh = makeAccount()
    sdk.fresh.mockResolvedValue(result(fresh))
    clock.mockReturnValue(6_000)
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

describe('planning account wallet and chain context', () => {
  it.each(['wallet', 'chain'] as const)('hides every previous-context candidate immediately on a %s switch', async (context) => {
    const previous = makeAccount()
    const nextChain = context === 'chain' ? 2 : 1
    const nextOwner = context === 'wallet' ? otherOwner : owner
    const fast = makeAccount(nextChain, nextOwner)
    const fresh = makeAccount(nextChain, nextOwner)
    const pendingFast = deferred<ReturnType<typeof result>>()
    const pendingFresh = deferred<ReturnType<typeof result>>()
    sdk.fast.mockResolvedValueOnce(result(previous)).mockReturnValue(pendingFast.promise)
    sdk.fresh.mockResolvedValueOnce(result(previous)).mockReturnValue(pendingFresh.promise)
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.activeLayerAccountRef.value = previous
    expect(app.plan.account.value).toBe(previous)

    if (context === 'wallet') app.effectiveAddress.value = nextOwner
    else app.chain.value = nextChain
    // Selection must change synchronously, before the load/reset watchers run.
    expect(app.loader.account.value).toBeUndefined()
    expect(app.plan.account.value).toBeUndefined()
    await nextTick()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()
    expect(app.loader.isLoading.value).toBe(true)

    pendingFast.resolve(result(fast))
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fast))
    pendingFresh.resolve(result(fresh))
    await vi.waitFor(() => expect(app.plan.account.value).toBe(fresh))
    expect(app.getBatchPrefetchedPlanningAccount()).toBe(fresh)
  })

  it.each(['wallet', 'chain'] as const)('discards late reads after a %s switch and stays unavailable when the new reads fail', async (context) => {
    const previous = makeAccount()
    const pendingPrevious = deferred<ReturnType<typeof result>>()
    sdk.fast.mockResolvedValueOnce(result(previous)).mockRejectedValue(new Error('V3 unavailable'))
    sdk.fresh.mockReturnValueOnce(pendingPrevious.promise).mockRejectedValue(new Error('RPC unavailable'))
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.account.value).toBe(previous))
    app.activeLayerAccountRef.value = previous

    if (context === 'wallet') app.effectiveAddress.value = otherOwner
    else app.chain.value = 2
    await vi.waitFor(() => expect(sdk.fresh).toHaveBeenCalledTimes(2))
    pendingPrevious.resolve(result(previous))
    await new Promise(resolve => setTimeout(resolve, 0))
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    expect(app.loader.account.value).toBeUndefined()
    expect(app.plan.account.value).toBeUndefined()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()

    const recovered = makeAccount(app.chain.value, app.effectiveAddress.value as Address)
    sdk.fast.mockResolvedValue(result(recovered))
    sdk.fresh.mockResolvedValue(result(recovered))
    app.loader.refresh()
    await vi.waitFor(() => expect(app.plan.account.value).toBe(recovered))
  })

  it('retains an eligible account during ordinary refreshes in the same context', async () => {
    const current = makeAccount()
    const pending = deferred<ReturnType<typeof result>>()
    sdk.fast.mockResolvedValueOnce(result(current)).mockReturnValue(pending.promise)
    sdk.fresh.mockResolvedValueOnce(result(current)).mockReturnValue(pending.promise)
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.loader.refresh()
    expect(app.loader.isLoading.value).toBe(true)
    expect(app.loader.account.value).toBe(current)
    expect(app.plan.account.value).toBe(current)
    expect(app.getBatchPrefetchedPlanningAccount()).toBe(current)
    pending.resolve(result(makeAccount()))
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
  })

  it('normalizes wallet casing without hiding or reloading the same account', async () => {
    const checksumOwner = getAddress('0xabcdef0000000000000000000000000000000001')
    const current = makeAccount(1, checksumOwner)
    sdk.fast.mockResolvedValue(result(current))
    sdk.fresh.mockResolvedValue(result(current))
    const app = await setup(checksumOwner)
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.effectiveAddress.value = checksumOwner.toLowerCase()
    expect(app.loader.account.value).toBe(current)
    expect(app.plan.account.value).toBe(current)
    await nextTick()
    expect(sdk.fast).toHaveBeenCalledOnce()
    expect(sdk.fresh).toHaveBeenCalledOnce()
  })

  it.each(['disconnected wallet', 'invalid wallet', 'missing chain'] as const)('hides all candidates for %s', async (context) => {
    const current = makeAccount()
    sdk.fast.mockResolvedValue(result(current))
    sdk.fresh.mockResolvedValue(result(current))
    const app = await setup()
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
    app.activeLayerAccountRef.value = current
    if (context === 'missing chain') app.chain.value = 0
    else app.effectiveAddress.value = context === 'invalid wallet' ? 'invalid' : undefined
    expect(app.loader.account.value).toBeUndefined()
    expect(app.plan.account.value).toBeUndefined()
    await nextTick()
    expect(app.getBatchPrefetchedPlanningAccount()).toBeUndefined()
    expect(app.plan.account.value).toBeUndefined()
  })

  it('preserves batch and portfolio priority only for the active context and confirmation', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    sdk.fast.mockReturnValue(pending.promise)
    sdk.fresh.mockReturnValue(pending.promise)
    const app = await setup()
    const batch = makeAccount()
    app.activeLayerAccountRef.value = batch
    expect(app.plan.account.value).toBe(batch)
    app.activeLayerAccountRef.value = makeAccount(2)
    expect(app.plan.account.value).toBe(app.portfolio.value.account)
    app.portfolio.value = { account: makeAccount(1, otherOwner) }
    expect(app.plan.account.value).toBeUndefined()
    app.portfolio.value = { account: makeAccount() }
    expect(app.plan.account.value).toBe(app.portfolio.value.account)
    app.requireFreshPlanningAccount(1, 123n, async () => {})
    expect(app.plan.account.value).toBeUndefined()
    pending.resolve(result(makeAccount()))
    await vi.waitFor(() => expect(app.loader.isLoading.value).toBe(false))
  })
})
