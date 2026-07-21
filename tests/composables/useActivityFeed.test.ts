import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { buildActivityFeedContextKey } from '~/composables/useActivityFeed'

const VAULT = '0x0000000000000000000000000000000000000001' as const
const OTHER_VAULT = '0x0000000000000000000000000000000000000002' as const
const TX_HASH = `0x${'1'.repeat(64)}` as const

const event = (
  id: string,
  vault: typeof VAULT | typeof OTHER_VAULT = VAULT,
  type = 'set_caps',
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id,
  chainId: 1,
  type,
  rawType: type === 'mint' || type === 'burn' ? 'transfer' : type,
  category: 'lending' as const,
  timestamp: '2026-07-13T10:30:00.000Z',
  blockNumber: '123',
  logIndex: 0,
  txHash: TX_HASH,
  source: 'v3-ponder',
  payload: {},
  vault,
  ...overrides,
} as ActivityEvent)

const page = (
  data: ActivityEvent[],
  { nextCursor = null, status = 'complete' }: {
    nextCursor?: string | null
    status?: 'complete' | 'partial' | 'unsupported' | 'syncing'
  } = {},
) => ({
  data,
  meta: {
    hasMore: nextCursor !== null,
    nextCursor,
    source: 'v3-ponder',
    timestamp: '2026-07-13T10:30:00.000Z',
    coverage: {
      status,
      chains: [{ chainId: 1, status, missingCategories: [] }],
      missingCategories: [],
    },
  },
})

describe('useActivityFeed', () => {
  let effect: EffectScope | undefined

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    effect?.stop()
    effect = undefined
    vi.restoreAllMocks()
  })

  const setup = async (
    fetchVaultActivityEvents: ReturnType<typeof vi.fn>,
    fetchAccountActivityEvents: ReturnType<typeof vi.fn> = vi.fn(),
  ) => {
    vi.stubGlobal('useEulerSdk', () => ({
      getEulerSdkForChain: vi.fn(async () => ({
        activityService: { fetchAccountActivityEvents, fetchVaultActivityEvents },
      })),
    }))
    return import('~/composables/useActivityFeed')
  }

  it('changes the key used to remount the activity accordion when vault scope changes', () => {
    expect(buildActivityFeedContextKey(
      { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
      [],
    )).not.toBe(buildActivityFeedContextKey(
      { kind: 'vault', vault: OTHER_VAULT, chainId: 1, vaultType: 'evk' },
      [],
    ))
  })

  it('does not request activity until enabled and forwards server-side categories', async () => {
    const fetchVaultActivityEvents = vi.fn(async (_args: { eventTypes?: readonly string[] }) => page([event('one')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(false)
    const categories = ref(['lending', 'governance'] as const)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories,
      })
    })
    await nextTick()
    expect(fetchVaultActivityEvents).not.toHaveBeenCalled()

    enabled.value = true
    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledWith({
      vault: VAULT,
      chainId: 1,
      vaultType: 'evk',
      categories: ['governance', 'lending'],
      eventTypes: expect.any(Array),
      limit: 25,
    })
    const requestedEventTypes = fetchVaultActivityEvents.mock.calls[0]?.[0]?.eventTypes
    expect(requestedEventTypes).toEqual(expect.arrayContaining([
      'deposit',
      'withdraw',
      'transfer',
      'borrow',
      'repay',
      'set_caps',
      'set_ltv',
      'liquidation',
    ]))
    expect(requestedEventTypes).not.toEqual(expect.arrayContaining([
      'interest_accrued',
      'accrue_interest',
      'mint',
      'burn',
    ]))
  })

  it('keeps core vault operations while dropping low-level accounting noise', async () => {
    const fetchVaultActivityEvents = vi.fn(async () => page([
      event('set-caps', VAULT, 'set_caps'),
      event('liquidation', VAULT, 'liquidation'),
      event('deposit', VAULT, 'deposit'),
      event('borrow', VAULT, 'borrow'),
      event('mint-shadow', VAULT, 'mint'),
      event('evk-interest', VAULT, 'interest_accrued'),
      event('earn-interest', VAULT, 'accrue_interest'),
      event('transfer', VAULT, 'transfer'),
      event('withdraw', VAULT, 'withdraw'),
      event('burn-shadow', VAULT, 'burn'),
    ]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: [],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual([
      'set-caps',
      'liquidation',
      'deposit',
      'borrow',
      'transfer',
      'withdraw',
    ]))
  })

  it('suppresses zero-value liquidation artifacts on every scope', async () => {
    const zeroLiquidation = event('zero-liquidation', VAULT, 'liquidation', {
      category: 'liquidations',
      assets: [
        { kind: 'assets', amountRaw: '0' },
        { kind: 'collateral', amountRaw: '0', address: OTHER_VAULT },
      ],
    })
    const liquidation = event('liquidation', VAULT, 'liquidation', {
      category: 'liquidations',
      assets: [
        { kind: 'assets', amountRaw: '1' },
        { kind: 'collateral', amountRaw: '2', address: OTHER_VAULT },
      ],
    })
    const fetchVaultActivityEvents = vi.fn(async () => page([zeroLiquidation, liquidation]))
    const fetchAccountActivityEvents = vi.fn(async () => page([zeroLiquidation, liquidation]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents, fetchAccountActivityEvents)
    let vaultFeed: ReturnType<typeof useActivityFeed> | undefined
    let accountFeed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      vaultFeed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: ['liquidations'],
      })
      accountFeed = useActivityFeed({
        scope: { kind: 'account', owner: VAULT, chainId: 1 },
        enabled: true,
        categories: ['liquidations'],
      })
    })

    await vi.waitFor(() => expect(vaultFeed?.events.value.map(item => item.id)).toEqual([
      'liquidation',
    ]))
    await vi.waitFor(() => expect(accountFeed?.events.value.map(item => item.id)).toEqual([
      'liquidation',
    ]))
  })

  it('removes a vault shadow transfer when its matching primary event arrives on an older page', async () => {
    const shadowTransfer = event('transfer-shadow', VAULT, 'transfer', {
      groupId: 'paired-transaction',
      assets: [{ kind: 'shares', address: VAULT, amountRaw: '100' }],
    })
    const deposit = event('deposit', VAULT, 'deposit', {
      groupId: 'paired-transaction',
      assets: [{ kind: 'shares', address: VAULT, amountRaw: '100' }],
    })
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([shadowTransfer], { nextCursor: 'next' }))
      .mockResolvedValueOnce(page([deposit]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: [],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['transfer-shadow']))
    await feed?.loadMore()

    expect(feed?.events.value.map(item => item.id)).toEqual(['deposit'])
  })

  it('retains loaded rows without refetching when collapsed and reopened', async () => {
    const fetchVaultActivityEvents = vi.fn(async () => page([event('one')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    enabled.value = false
    await nextTick()
    enabled.value = true
    await nextTick()

    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(1)
    expect(feed?.events.value.map(item => item.id)).toEqual(['one'])
  })

  it('refreshes stale rows when reopened while retaining the last-good page', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let resolveRefresh: ((value: ReturnType<typeof page>) => void) | undefined
    const refresh = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveRefresh = resolve
    })
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')]))
      .mockReturnValueOnce(refresh)
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    enabled.value = false
    await nextTick()
    now += 60_001
    enabled.value = true

    await vi.waitFor(() => expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2))
    expect(feed?.events.value.map(item => item.id)).toEqual(['one'])
    expect(feed?.isRefreshing.value).toBe(true)

    resolveRefresh?.(page([event('new')]))
    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['new']))
  })

  it('retries a cold failure when the collapsed feed is opened', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockResolvedValueOnce(page([event('recovered')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.hasColdError.value).toBe(true))
    enabled.value = false
    await nextTick()
    enabled.value = true

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['recovered']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2)
  })

  it('retries a cold refresh that was interrupted by collapsing the feed', async () => {
    let resolveInterrupted: ((value: ReturnType<typeof page>) => void) | undefined
    const interrupted = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveInterrupted = resolve
    })
    const fetchVaultActivityEvents = vi.fn()
      .mockRejectedValueOnce(new Error('backend unavailable'))
      .mockReturnValueOnce(interrupted)
      .mockResolvedValueOnce(page([event('recovered')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.hasColdError.value).toBe(true))
    enabled.value = false
    await nextTick()
    enabled.value = true
    await vi.waitFor(() => expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2))

    enabled.value = false
    await nextTick()
    enabled.value = true

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['recovered']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(3)

    resolveInterrupted?.(page([event('interrupted')]))
    await nextTick()
    expect(feed?.events.value.map(item => item.id)).toEqual(['recovered'])
  })

  it('refreshes an invalidated activity query when the feed is reopened', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')]))
      .mockResolvedValueOnce(page([event('new')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    enabled.value = false
    await nextTick()

    const { invalidateSdkQueries } = await import('~/utils/sdk-query-cache')
    await invalidateSdkQueries(['queryVaultActivityEvents' as never])
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(1)

    enabled.value = true
    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['new']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2)
  })

  it('refreshes an invalidated activity query while the feed is open', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')]))
      .mockResolvedValueOnce(page([event('new')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    const { invalidateSdkQueries } = await import('~/utils/sdk-query-cache')
    await invalidateSdkQueries(['queryVaultActivityEvents' as never])

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['new']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2)
  })

  it('retries an invalidation refresh that was interrupted by collapsing the feed', async () => {
    let resolveInterrupted: ((value: ReturnType<typeof page>) => void) | undefined
    const interrupted = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveInterrupted = resolve
    })
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')]))
      .mockReturnValueOnce(interrupted)
      .mockResolvedValueOnce(page([event('new')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const enabled = ref(true)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled,
        categories: ['lending'],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['one']))
    const { invalidateSdkQueries } = await import('~/utils/sdk-query-cache')
    await invalidateSdkQueries(['queryVaultActivityEvents' as never])
    await vi.waitFor(() => expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2))

    enabled.value = false
    await nextTick()
    enabled.value = true

    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['new']))
    expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(3)

    resolveInterrupted?.(page([event('interrupted')]))
    await nextTick()
    expect(feed?.events.value.map(item => item.id)).toEqual(['new'])
  })

  it('ignores superseded context responses', async () => {
    let resolveFirst: ((value: ReturnType<typeof page>) => void) | undefined
    let resolveSecond: ((value: ReturnType<typeof page>) => void) | undefined
    const first = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveSecond = resolve
    })
    const fetchVaultActivityEvents = vi.fn(({ vault }: { vault: string }) => vault === VAULT ? first : second)
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    const feedScope = ref<{
      kind: 'vault'
      vault: typeof VAULT | typeof OTHER_VAULT
      chainId: 1
      vaultType: 'evk'
    }>({ kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' })
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({ scope: feedScope, enabled: true, categories: [] })
    })

    await vi.waitFor(() => expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(1))
    feedScope.value = { kind: 'vault', vault: OTHER_VAULT, chainId: 1, vaultType: 'evk' }
    await vi.waitFor(() => expect(fetchVaultActivityEvents).toHaveBeenCalledTimes(2))

    resolveSecond?.(page([event('new', OTHER_VAULT)]))
    await vi.waitFor(() => expect(feed?.events.value.map(item => item.id)).toEqual(['new']))
    resolveFirst?.(page([event('old')]))
    await nextTick()

    expect(feed?.events.value.map(item => item.id)).toEqual(['new'])
  })

  it('retains last-good rows when a same-context refresh fails', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')]))
      .mockRejectedValueOnce(new Error('backend unavailable'))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: [],
      })
    })

    await vi.waitFor(() => expect(feed?.events.value).toHaveLength(1))
    await feed?.refresh()

    expect(feed?.events.value.map(item => item.id)).toEqual(['one'])
    expect(feed?.hasStaleError.value).toBe(true)
    expect(feed?.hasColdError.value).toBe(false)
    expect(feed?.isEmpty.value).toBe(false)
  })

  it('keeps load-more failures separate and deduplicates a retried page', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([event('one')], { nextCursor: 'next' }))
      .mockRejectedValueOnce(new Error('older page unavailable'))
      .mockResolvedValueOnce(page([event('one'), event('two')]))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: [],
      })
    })

    await vi.waitFor(() => expect(feed?.hasMore.value).toBe(true))
    await feed?.loadMore()
    expect(feed?.events.value.map(item => item.id)).toEqual(['one'])
    expect(feed?.loadMoreError.value?.message).toBe('older page unavailable')
    expect(feed?.error.value).toBeUndefined()

    await feed?.loadMore()
    expect(fetchVaultActivityEvents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next' }))
    expect(feed?.events.value.map(item => item.id)).toEqual(['one', 'two'])
    expect(feed?.loadMoreError.value).toBeUndefined()
  })

  it('distinguishes empty, partial, syncing and unsupported coverage', async () => {
    const fetchVaultActivityEvents = vi.fn()
      .mockResolvedValueOnce(page([], { status: 'complete' }))
      .mockResolvedValueOnce(page([], { status: 'partial' }))
      .mockResolvedValueOnce(page([], { status: 'syncing' }))
      .mockResolvedValueOnce(page([], { status: 'unsupported' }))
    const { useActivityFeed } = await setup(fetchVaultActivityEvents)
    let feed: ReturnType<typeof useActivityFeed> | undefined
    effect = effectScope()
    effect.run(() => {
      feed = useActivityFeed({
        scope: { kind: 'vault', vault: VAULT, chainId: 1, vaultType: 'evk' },
        enabled: true,
        categories: [],
      })
    })

    await vi.waitFor(() => expect(feed?.isEmpty.value).toBe(true))
    await feed?.refresh()
    expect(feed?.isPartial.value).toBe(true)
    expect(feed?.isEmpty.value).toBe(false)
    await feed?.refresh()
    expect(feed?.isSyncing.value).toBe(true)
    expect(feed?.isEmpty.value).toBe(false)
    await feed?.refresh()
    expect(feed?.isUnsupported.value).toBe(true)
    expect(feed?.isEmpty.value).toBe(false)
  })
})
