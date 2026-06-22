import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { getAddress, parseUnits, type Address } from 'viem'
import { isExternalMigrationDustPosition, useExternalMigrationPositions, type ExternalMigrationCandidate } from '~/composables/useExternalMigrationPositions'

const eulerSdkMock = vi.hoisted(() => ({
  fetchAssetUsdPriceByAddress: vi.fn(),
  getEulerSdk: vi.fn(),
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: eulerSdkMock.getEulerSdk,
}))

const OWNER = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const MARKET_ID = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda'
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const WETH = getAddress('0x4200000000000000000000000000000000000006')
const AAVE_POOL = getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5')
const AAVE_WETH = getAddress('0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7')
const AAVE_STABLE_DEBT_USDC = getAddress('0x0000000000000000000000000000000000000001')
const AAVE_VARIABLE_DEBT_USDC = getAddress('0x59dca05b6c26dbd64b5381374aAaC5CD05644C28')
const MORPHO_ORACLE = getAddress('0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4')
const MORPHO_IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))
const priceResult = (price: string) => {
  const amountOutMid = parseUnits(price, 18)
  return {
    amountOutMid,
    amountOutAsk: amountOutMid,
    amountOutBid: amountOutMid,
  }
}

const market = {
  marketId: MARKET_ID,
  lltv: '860000000000000000',
  irmAddress: MORPHO_IRM,
  oracle: { address: MORPHO_ORACLE },
  loanAsset: { address: USDC, symbol: 'USDC', decimals: 6 },
  collateralAsset: { address: WETH, symbol: 'WETH', decimals: 18 },
  state: { borrowApy: '0.0449' },
}

const aaveSupplyCandidate = (amountUsd: number | null): ExternalMigrationCandidate => ({
  connectorId: 'aave',
  protocol: 'Aave V3',
  id: `aave:${AAVE_POOL}:${WETH}:supply`,
  chainId: 8453,
  owner: OWNER,
  ref: {
    collateralAsset: WETH,
    pool: AAVE_POOL,
  },
  debt: null,
  collateral: {
    address: WETH,
    symbol: 'WETH',
    decimals: 18,
    amount: 1n,
    amountUsd,
  },
  borrowApy: null,
  lltv: null,
  raw: {
    variableDebt: 0n,
    stableDebt: 0n,
  },
})

const morphoBorrowCandidate = (collateralUsd: number | null, debtUsd: number | null): ExternalMigrationCandidate => ({
  connectorId: 'morpho',
  protocol: 'Morpho',
  id: MARKET_ID,
  chainId: 8453,
  owner: OWNER,
  ref: {
    loanToken: USDC,
    collateralToken: WETH,
    oracle: MORPHO_ORACLE,
    irm: MORPHO_IRM,
    lltv: 860000000000000000n,
  },
  debt: {
    address: USDC,
    symbol: 'USDC',
    decimals: 6,
    amount: 1n,
    amountUsd: debtUsd,
  },
  collateral: {
    address: WETH,
    symbol: 'WETH',
    decimals: 18,
    amount: 1n,
    amountUsd: collateralUsd,
  },
  borrowApy: null,
  lltv: 0.86,
})

describe('useExternalMigrationPositions', () => {
  let readContract: ReturnType<typeof vi.fn>
  let multicall: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>
  let aaveUserConfiguration: bigint
  let aaveReserves: Address[]
  let reserveTokensByAsset: Map<Address, {
    aTokenAddress: Address
    stableDebtTokenAddress: Address
    variableDebtTokenAddress: Address
  }>
  let balancesByToken: Map<Address, bigint>

  beforeEach(() => {
    vi.restoreAllMocks()
    eulerSdkMock.fetchAssetUsdPriceByAddress.mockReset()
    eulerSdkMock.getEulerSdk.mockReset()
    eulerSdkMock.fetchAssetUsdPriceByAddress.mockImplementation(async (_chainId: number, asset: Address) => {
      if (getAddress(asset) === WETH) return priceResult('2500')
      if (getAddress(asset) === USDC) return priceResult('1')
      return undefined
    })
    eulerSdkMock.getEulerSdk.mockResolvedValue({
      priceService: {
        fetchAssetUsdPriceByAddress: eulerSdkMock.fetchAssetUsdPriceByAddress,
      },
    })

    aaveUserConfiguration = 0n
    aaveReserves = []
    reserveTokensByAsset = new Map()
    balancesByToken = new Map()

    const state = new Map<string, Ref<unknown>>()
    vi.stubGlobal('useState', (key: string, init: () => unknown) => {
      let entry = state.get(key)
      if (!entry) {
        entry = ref(init())
        state.set(key, entry)
      }
      return entry
    })

    readContract = vi.fn(async ({ address, functionName, args }: { address: Address, functionName: string, args?: readonly unknown[] }) => {
      if (functionName === 'getUserConfiguration') return { data: aaveUserConfiguration }
      if (functionName === 'getReservesList') return aaveReserves
      if (functionName === 'getReserveData') {
        const asset = getAddress(args?.[0] as Address)
        const tokens = reserveTokensByAsset.get(asset)
        if (!tokens) throw new Error(`unexpected Aave reserve ${asset}`)
        return tokens
      }
      if (functionName === 'symbol') {
        const asset = getAddress(address)
        if (asset === WETH) return 'WETH'
        if (asset === USDC) return 'USDC'
        throw new Error(`unexpected symbol ${asset}`)
      }
      if (functionName === 'decimals') {
        const asset = getAddress(address)
        if (asset === WETH) return 18
        if (asset === USDC) return 6
        throw new Error(`unexpected decimals ${asset}`)
      }
      if (functionName === 'balanceOf') return balancesByToken.get(getAddress(address)) ?? 0n
      throw new Error(`unexpected readContract ${functionName}`)
    })
    multicall = vi.fn(async () => {
      throw new Error('client chain not configured. multicallAddress is required.')
    })

    vi.stubGlobal('useWagmi', () => ({ address: ref(OWNER) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(null) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(8453) }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref({ multicall, readContract }) }))
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      if (body.query?.includes('LiteMorphoMigrationPositions')) {
        return new Response(JSON.stringify({
          data: {
            userByAddress: {
              address: OWNER,
              marketPositions: [],
            },
          },
        }))
      }
      return new Response(JSON.stringify({
        data: {
          markets: { items: [] },
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('does not fetch positions while disabled', async () => {
    const result = useExternalMigrationPositions({ enabled: ref(false) })

    await flushPromises()
    await nextTick()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.positions.value).toEqual([])
    expect(result.isLoading.value).toBe(false)
  })

  it('discovers Morpho positions from indexed market positions', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: {
        userByAddress: {
          address: OWNER,
          marketPositions: [{
            market,
            state: {
              borrowAssets: '25',
              borrowAssetsUsd: '25',
              collateral: '100',
              collateralUsd: '250000',
            },
          }],
        },
      },
    })))

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'position' }))
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'market' }))
    expect(result.positions.value).toHaveLength(1)
    expect(result.positions.value[0]).toMatchObject({
      id: MARKET_ID,
      protocol: 'Morpho',
      owner: OWNER,
      debt: expect.objectContaining({
        address: USDC,
        amount: 25n,
        amountUsd: 25,
        symbol: 'USDC',
      }),
      collateral: expect.objectContaining({
        address: WETH,
        amount: 100n,
        amountUsd: 250000,
        symbol: 'WETH',
      }),
    })
  })

  it('discovers Aave V3 collateral and variable debt positions from reserve data', async () => {
    aaveUserConfiguration = 6n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: getAddress('0x0000000000000000000000000000000000000020'),
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    balancesByToken.set(AAVE_VARIABLE_DEBT_USDC, 1_000_000n)
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      if (body.query?.includes('LiteMorphoMigrationPositions')) {
        return new Response(JSON.stringify({
          data: {
            userByAddress: {
              address: OWNER,
              marketPositions: [],
            },
          },
        }))
      }
      return new Response(JSON.stringify({
        data: {
          markets: { items: [] },
        },
      }))
    })

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toHaveLength(1)
    expect(result.positions.value[0]).toMatchObject({
      connectorId: 'aave',
      protocol: 'Aave V3',
      id: `aave:${AAVE_POOL}:${WETH}:${USDC}:variable`,
      owner: OWNER,
      debt: expect.objectContaining({
        address: USDC,
        amount: 1_000_000n,
        amountUsd: 1,
        symbol: 'USDC',
      }),
      collateral: expect.objectContaining({
        address: WETH,
        amount: 1_000_000_000_000_000n,
        amountUsd: 2.5,
        symbol: 'WETH',
      }),
    })
  })

  it('discovers Aave V3 supply-only positions when the wallet has collateral and no debt', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      if (body.query?.includes('LiteMorphoMigrationPositions')) {
        return new Response(JSON.stringify({
          data: {
            userByAddress: {
              address: OWNER,
              marketPositions: [],
            },
          },
        }))
      }
      return new Response(JSON.stringify({
        data: {
          markets: { items: [] },
        },
      }))
    })

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toHaveLength(1)
    expect(result.positions.value[0]).toMatchObject({
      connectorId: 'aave',
      protocol: 'Aave V3',
      id: `aave:${AAVE_POOL}:${WETH}:supply`,
      owner: OWNER,
      debt: null,
      collateral: expect.objectContaining({
        address: WETH,
        amount: 1_000_000_000_000_000n,
        amountUsd: 2.5,
        symbol: 'WETH',
      }),
    })
  })

  it('sorts discovered positions by net asset or deposit value descending', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
      if (body.query?.includes('LiteMorphoMigrationPositions')) {
        return new Response(JSON.stringify({
          data: {
            userByAddress: {
              address: OWNER,
              marketPositions: [{
                market,
                state: {
                  borrowAssets: '25',
                  borrowAssetsUsd: '25',
                  collateral: '100',
                  collateralUsd: '250000',
                },
              }],
            },
          },
        }))
      }
      return new Response(JSON.stringify({
        data: {
          markets: { items: [] },
        },
      }))
    })

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value.map(position => position.id)).toEqual([
      MARKET_ID,
      `aave:${AAVE_POOL}:${WETH}:supply`,
    ])
  })

  it('identifies dust positions from priced migration legs', () => {
    expect(isExternalMigrationDustPosition(aaveSupplyCandidate(0.01))).toBe(true)
    expect(isExternalMigrationDustPosition(aaveSupplyCandidate(0.010001))).toBe(false)
    expect(isExternalMigrationDustPosition(aaveSupplyCandidate(null))).toBe(false)
    expect(isExternalMigrationDustPosition(morphoBorrowCandidate(0.01, 0.009))).toBe(true)
    expect(isExternalMigrationDustPosition(morphoBorrowCandidate(100, 99.995))).toBe(false)
  })
})
