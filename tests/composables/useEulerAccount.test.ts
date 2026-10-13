import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'

const owner = '0x1000000000000000000000000000000000000000'

const importUseEulerAccount = async (visibleOverrides: Record<string, unknown> = {}) => {
  vi.resetModules()

  const fetchPortfolio = vi.fn(async () => ({
    errors: [],
    result: {
      account: { owner },
      borrows: ['all-borrow'],
      savings: ['all-saving'],
      totalSuppliedValueUsd: 100,
      totalBorrowedValueUsd: 25,
      netAssetValueUsd: 75,
      roe: 3,
      netApy: 2,
    },
  }))
  const buildPortfolio = vi.fn(() => ({
    account: { owner },
    borrows: ['visible-borrow'],
    savings: [],
    totalSuppliedValueUsd: 40,
    totalBorrowedValueUsd: 10,
    netAssetValueUsd: 30,
    roe: 1,
    netApy: 0.5,
    ...visibleOverrides,
  }))
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
  }, 20_000)

  it('flags partial pricing when one position in view has no price', async () => {
    const priced = (suppliedValueUsd: number) => ({ assets: 10n, shares: 10n, suppliedValueUsd })
    const { useEulerAccount, buildPortfolio } = await importUseEulerAccount({
      savings: [priced(20), { assets: 10n, shares: 10n, suppliedValueUsd: undefined }],
      borrows: [
        { borrowed: 5n, borrow: { borrowedValueUsd: 10 }, collaterals: [priced(40)] },
        { borrowed: 3n, borrow: { borrowedValueUsd: undefined }, collaterals: [priced(30)] },
      ],
      totalSuppliedValueUsd: 90,
      totalBorrowedValueUsd: 10,
      netAssetValueUsd: 80,
    })

    let account: ReturnType<typeof useEulerAccount> | undefined
    scope = effectScope()
    scope.run(() => {
      account = useEulerAccount()
    })

    await vi.waitFor(() => expect(buildPortfolio).toHaveBeenCalledTimes(1))
    expect(account?.totalSuppliedValueInfo.value).toEqual({ total: 90, hasMissingPrices: true })
    expect(account?.totalBorrowedValueInfo.value).toEqual({ total: 10, hasMissingPrices: true })
    expect(account?.netAssetMarketValueInfo.value).toEqual({ total: 80, hasMissingPrices: true })
  }, 20_000)

  it('does not flag partial pricing when every position in view is priced', async () => {
    const { useEulerAccount, buildPortfolio } = await importUseEulerAccount({
      savings: [{ assets: 10n, shares: 10n, suppliedValueUsd: 20 }],
      borrows: [{ borrowed: 5n, borrow: { borrowedValueUsd: 10 }, collaterals: [{ assets: 10n, shares: 10n, suppliedValueUsd: 40 }] }],
      totalSuppliedValueUsd: 60,
      totalBorrowedValueUsd: 10,
      netAssetValueUsd: 50,
    })

    let account: ReturnType<typeof useEulerAccount> | undefined
    scope = effectScope()
    scope.run(() => {
      account = useEulerAccount()
    })

    await vi.waitFor(() => expect(buildPortfolio).toHaveBeenCalledTimes(1))
    expect(account?.totalSuppliedValueInfo.value.hasMissingPrices).toBe(false)
    expect(account?.totalBorrowedValueInfo.value.hasMissingPrices).toBe(false)
    expect(account?.netAssetMarketValueInfo.value.hasMissingPrices).toBe(false)
  }, 20_000)
})
