import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'

const owner = '0x1000000000000000000000000000000000000000'

const fetchedPortfolio = {
  account: { owner },
  borrows: ['all-borrow'],
  savings: ['all-saving'],
  totalSuppliedValueUsd: 100,
  totalBorrowedValueUsd: 25,
  netAssetValueUsd: 75,
  roe: 3,
  netApy: 2,
}

const visiblePortfolio = {
  account: { owner },
  borrows: ['visible-borrow'],
  savings: [],
  totalSuppliedValueUsd: 40,
  totalBorrowedValueUsd: 10,
  netAssetValueUsd: 30,
  roe: 1,
  netApy: 0.5,
}

const portfolioResponse = () => ({
  errors: [],
  result: fetchedPortfolio,
})

const importUseEulerAccount = async (
  { failFetch = false, fetchPortfolioImpl }: {
    failFetch?: boolean
    fetchPortfolioImpl?: () => Promise<ReturnType<typeof portfolioResponse>>
  } = {},
) => {
  vi.resetModules()

  const fetchPortfolio = vi.fn(async () => {
    if (fetchPortfolioImpl) return fetchPortfolioImpl()
    if (failFetch) throw new Error('portfolio source unavailable')
    return portfolioResponse()
  })
  const buildPortfolio = vi.fn(() => visiblePortfolio)
  const sdk = {
    portfolioService: {
      fetchPortfolio,
      buildPortfolio,
    },
  }

  vi.doMock('~/composables/useVaults', () => ({
    useVaults: () => ({ isReady: ref(true) }),
  }))
  vi.doMock('~/composables/useWallets', () => ({
    useWallets: () => ({ isLoaded: ref(true) }),
  }))

  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    verifiedVaultAddresses: ref([]),
    earnVaults: ref([]),
  }))
  vi.stubGlobal('useVaultRegistry', () => ({
    escrowAddresses: ref([]),
    getEscrowVaults: () => [],
  }))
  vi.stubGlobal('useEulerAddresses', () => ({
    isReady: ref(true),
    chainId: ref(1),
  }))
  vi.stubGlobal('useWagmi', () => ({
    address: ref(owner),
  }))
  vi.stubGlobal('useSpyMode', () => ({
    spyAddress: ref(''),
  }))
  vi.stubGlobal('useEffectiveAddress', () => ({
    address: ref(owner),
    isConnected: ref(true),
    isSpyMode: ref(false),
    spyAddress: ref(''),
    effectiveAddress: ref(owner),
  }))
  vi.stubGlobal('useEulerSdk', () => ({
    getEulerSdk: vi.fn(async () => sdk),
    getEulerSdkFresh: vi.fn(async () => sdk),
  }))

  const module = await import('~/composables/useEulerAccount')
  return {
    ...module,
    fetchPortfolio,
    buildPortfolio,
  }
}

describe('useEulerAccount', () => {
  let scope: EffectScope | undefined

  beforeEach(() => {
    scope = undefined
  })

  afterEach(() => {
    scope?.stop()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('switches show-all locally without refetching the account', async () => {
    const { useEulerAccount, fetchPortfolio, buildPortfolio } = await importUseEulerAccount()

    let account: ReturnType<typeof useEulerAccount> | undefined
    scope = effectScope()
    scope.run(() => {
      account = useEulerAccount()
    })

    await vi.waitFor(() => expect(fetchPortfolio).toHaveBeenCalledTimes(1))
    expect(buildPortfolio).toHaveBeenCalledTimes(1)
    expect(fetchPortfolio.mock.calls[0]).toHaveLength(2)
    expect(account?.borrowPositions.value).toEqual(['visible-borrow'])
    expect(account?.depositPositions.value).toEqual([])
    expect(account?.hiddenBorrowCount.value).toBe(0)
    expect(account?.hiddenDepositCount.value).toBe(1)
    expect(account?.totalSuppliedValue.value).toBe(40)

    account!.isShowAllPositions.value = true
    await nextTick()

    expect(fetchPortfolio).toHaveBeenCalledTimes(1)
    expect(buildPortfolio).toHaveBeenCalledTimes(1)
    expect(account?.borrowPositions.value).toEqual(['all-borrow'])
    expect(account?.depositPositions.value).toEqual(['all-saving'])
    expect(account?.totalSuppliedValue.value).toBe(100)
  })

  it('flags a load error (rather than showing zeros) when the fetch fails with no data to fall back on', async () => {
    const { useEulerAccount, fetchPortfolio } = await importUseEulerAccount({ failFetch: true })

    let account: ReturnType<typeof useEulerAccount> | undefined
    scope = effectScope()
    scope.run(() => {
      account = useEulerAccount()
    })

    await vi.waitFor(() => expect(fetchPortfolio).toHaveBeenCalled())
    await vi.waitFor(() => expect(account?.hasPortfolioLoadError.value).toBe(true))

    // No portfolio is present, so the totals are zero — the error flag is what
    // lets the page render an error state instead of a misleading $0.00.
    expect(account?.portfolio.value).toBeUndefined()
    expect(account?.totalSuppliedValue.value).toBe(0)
    expect(account?.portfolioDiagnostics.value.some(issue => issue.severity === 'error')).toBe(true)
  })

  it('keeps the load error visible until a retry confirms new data', async () => {
    let resolveRetry: ((value: ReturnType<typeof portfolioResponse>) => void) | undefined
    const fetchPortfolioImpl = vi.fn()
      .mockRejectedValueOnce(new Error('portfolio source unavailable'))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof portfolioResponse>>((resolve) => {
        resolveRetry = resolve
      }))

    const { useEulerAccount, fetchPortfolio } = await importUseEulerAccount({ fetchPortfolioImpl })

    let account: ReturnType<typeof useEulerAccount> | undefined
    scope = effectScope()
    scope.run(() => {
      account = useEulerAccount()
    })

    await vi.waitFor(() => expect(fetchPortfolio).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(account?.hasPortfolioLoadError.value).toBe(true))

    const retry = account!.refreshAllPositions(undefined, owner, { preempt: true })
    await vi.waitFor(() => expect(fetchPortfolio).toHaveBeenCalledTimes(2))

    expect(account?.portfolio.value).toBeUndefined()
    expect(account?.hasPortfolioLoadError.value).toBe(true)

    resolveRetry?.(portfolioResponse())
    await retry

    expect(account?.portfolio.value).toEqual(visiblePortfolio)
    expect(account?.hasPortfolioLoadError.value).toBe(false)
  })
})
