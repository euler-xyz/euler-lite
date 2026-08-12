import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import { getAddress, parseUnits, type Address } from 'viem'
import { isExternalMigrationDustPosition, useExternalMigrationPositions, type ExternalMigrationCandidate, type MetamorphoMigrationCandidate } from '~/composables/useExternalMigrationPositions'

const eulerSdkMock = vi.hoisted(() => ({
  fetchAssetUsdPriceByAddress: vi.fn(),
  getConnectorProtocolAddress: vi.fn(),
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
const AAVE_USDC = getAddress('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB')
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

const METAMORPHO_V1_VAULT = getAddress('0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB')
const METAMORPHO_V2_VAULT = getAddress('0x0229dB3921dE71CFa43Cfe9fb6A87b403647A9ae')
const METAMORPHO_EMPTY_VAULT = getAddress('0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458')

const metamorphoCandidate = (amountUsd: number | null): MetamorphoMigrationCandidate => ({
  connectorId: 'metamorpho',
  protocol: 'Morpho Vaults',
  id: `metamorpho:${METAMORPHO_V1_VAULT}:supply`,
  chainId: 8453,
  owner: OWNER,
  ref: {
    vault: METAMORPHO_V1_VAULT,
    version: 'v1',
  },
  debt: null,
  collateral: {
    address: USDC,
    symbol: 'USDC',
    decimals: 6,
    amount: 1n,
    amountUsd,
  },
  borrowApy: null,
  lltv: null,
  vaultName: 'Steakhouse USDC',
  shares: 1n,
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
    eulerSdkMock.getConnectorProtocolAddress.mockReset()
    eulerSdkMock.getEulerSdk.mockReset()
    eulerSdkMock.fetchAssetUsdPriceByAddress.mockImplementation(async (_chainId: number, asset: Address) => {
      if (getAddress(asset) === WETH) return priceResult('2500')
      if (getAddress(asset) === USDC) return priceResult('1')
      return undefined
    })
    eulerSdkMock.getConnectorProtocolAddress.mockImplementation((connectorId: string, chainId: number) =>
      connectorId === 'aave' && chainId === 8453 ? AAVE_POOL : undefined,
    )
    eulerSdkMock.getEulerSdk.mockResolvedValue({
      priceService: {
        fetchAssetUsdPriceByAddress: eulerSdkMock.fetchAssetUsdPriceByAddress,
      },
      positionMigrationService: {
        getConnectorProtocolAddress: eulerSdkMock.getConnectorProtocolAddress,
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

  it('skips Morpho discovery on chains its indexer does not support', async () => {
    // BNB Smart Chain (56) is not indexed by api.morpho.org, and no Aave pool is
    // registered there either — so the scan must resolve to an empty list rather
    // than surfacing the API's "unsupported chainId" error.
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(56) }))

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    const morphoQueried = fetchMock.mock.calls.some(([, init]) =>
      String((init as RequestInit | undefined)?.body ?? '').includes('LiteMorphoMigrationPositions'),
    )
    expect(morphoQueried).toBe(false)
    expect(result.positions.value).toEqual([])
    expect(result.error.value).toBe('')
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

  it('surfaces an error when an Aave balance read fails instead of hiding the position', async () => {
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
    balancesByToken.set(AAVE_VARIABLE_DEBT_USDC, 1_000_000n)
    const baseReadContract = readContract.getMockImplementation() as (
      call: { address: Address, functionName: string, args?: readonly unknown[] },
    ) => Promise<unknown>
    readContract.mockImplementation(async (call: { address: Address, functionName: string, args?: readonly unknown[] }) => {
      if (call.functionName === 'balanceOf' && getAddress(call.address) === AAVE_WETH) {
        throw new Error('rpc blip')
      }
      return baseReadContract(call)
    })

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toEqual([])
    expect(result.error.value).toContain('Aave discovery read failed')
  })

  it('keeps valid Aave and Morpho rows when an unrelated Aave reserve read fails', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
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

    expect(result.positions.value.map(position => position.id)).toEqual([
      MARKET_ID,
      `aave:${AAVE_POOL}:${WETH}:supply`,
    ])
    expect(result.error.value).toBe('')
  })

  it('keeps valid Aave and Morpho rows when an unrelated Aave supply balance read fails', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    const baseReadContract = readContract.getMockImplementation() as (
      call: { address: Address, functionName: string, args?: readonly unknown[] },
    ) => Promise<unknown>
    readContract.mockImplementation(async (call: { address: Address, functionName: string, args?: readonly unknown[] }) => {
      if (call.functionName === 'balanceOf' && getAddress(call.address) === AAVE_USDC) {
        throw new Error('unrelated USDC balance failure')
      }
      return baseReadContract(call)
    })
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

    expect(result.positions.value.map(position => position.id)).toEqual([
      MARKET_ID,
      `aave:${AAVE_POOL}:${WETH}:supply`,
    ])
    expect(result.error.value).toBe('')
  })

  it('keeps valid Aave and Morpho rows when another supplied asset metadata read fails', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    balancesByToken.set(AAVE_USDC, 4_000_001n)
    const baseReadContract = readContract.getMockImplementation() as (
      call: { address: Address, functionName: string, args?: readonly unknown[] },
    ) => Promise<unknown>
    readContract.mockImplementation(async (call: { address: Address, functionName: string, args?: readonly unknown[] }) => {
      if (call.functionName === 'symbol' && getAddress(call.address) === USDC) {
        throw new Error('USDC symbol failure')
      }
      return baseReadContract(call)
    })
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

    expect(result.positions.value.map(position => position.id)).toEqual([
      MARKET_ID,
      `aave:${AAVE_POOL}:${WETH}:supply`,
    ])
    expect(result.error.value).toBe('')
  })

  it('fails Aave discovery when reserve data fails for a configured collateral', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toEqual([])
    expect(result.error.value).toContain(`Aave discovery read failed: getReserveData(${WETH})`)
  })

  it('discovers Aave V3 supply-only positions when the wallet has collateral and no debt', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
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

  it('discovers Aave V3 supply-only positions that are not enabled as collateral', async () => {
    aaveUserConfiguration = 0n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })
    balancesByToken.set(AAVE_USDC, 4_000_001n)

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toHaveLength(1)
    expect(result.positions.value[0]).toMatchObject({
      connectorId: 'aave',
      protocol: 'Aave V3',
      id: `aave:${AAVE_POOL}:${USDC}:supply`,
      owner: OWNER,
      debt: null,
      collateral: expect.objectContaining({
        address: USDC,
        amount: 4_000_001n,
        amountUsd: 4.000001,
        symbol: 'USDC',
      }),
    })
  })

  it('keeps non-collateral supplies separate from debt-backed Aave positions', async () => {
    aaveUserConfiguration = 6n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
    })
    balancesByToken.set(AAVE_WETH, 1_000_000_000_000_000n)
    balancesByToken.set(AAVE_USDC, 4_000_001n)
    balancesByToken.set(AAVE_VARIABLE_DEBT_USDC, 1_000_000n)

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value.map(position => ({ id: position.id, debt: position.debt?.amount ?? null }))).toEqual([
      { id: `aave:${AAVE_POOL}:${USDC}:supply`, debt: null },
      { id: `aave:${AAVE_POOL}:${WETH}:${USDC}:variable`, debt: 1_000_000n },
    ])
  })

  it('sorts discovered positions by net asset or deposit value descending', async () => {
    aaveUserConfiguration = 2n
    aaveReserves = [WETH, USDC]
    reserveTokensByAsset.set(WETH, {
      aTokenAddress: AAVE_WETH,
      stableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000011'),
      variableDebtTokenAddress: getAddress('0x0000000000000000000000000000000000000012'),
    })
    reserveTokensByAsset.set(USDC, {
      aTokenAddress: AAVE_USDC,
      stableDebtTokenAddress: AAVE_STABLE_DEBT_USDC,
      variableDebtTokenAddress: AAVE_VARIABLE_DEBT_USDC,
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
    expect(isExternalMigrationDustPosition(metamorphoCandidate(0.01))).toBe(true)
    expect(isExternalMigrationDustPosition(metamorphoCandidate(250))).toBe(false)
  })

  it('discovers Metamorpho v1 and v2 vault positions and skips empty ones', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: {
        userByAddress: {
          address: OWNER,
          marketPositions: [],
          vaultPositions: [
            {
              vault: {
                address: METAMORPHO_V1_VAULT,
                name: 'Steakhouse USDC',
                symbol: 'steakUSDC',
                asset: { address: USDC, symbol: 'USDC', decimals: 6 },
              },
              state: {
                shares: '95000000000000000000',
                assets: '100000000',
                assetsUsd: 100.02,
              },
            },
            {
              vault: {
                address: METAMORPHO_EMPTY_VAULT,
                name: 'Gauntlet USDC Core',
                symbol: 'gtUSDCcore',
                asset: { address: USDC, symbol: 'USDC', decimals: 6 },
              },
              state: { shares: 0, assets: 0, assetsUsd: 0 },
            },
          ],
          vaultV2Positions: [
            {
              vault: {
                address: METAMORPHO_V2_VAULT,
                name: 'Hyperithm USDC Core',
                symbol: 'hyperUSDCc',
                asset: { address: USDC, symbol: 'USDC', decimals: 6 },
              },
              shares: '4000000000000000000',
              assets: '4200000',
              assetsUsd: 4.2,
            },
          ],
        },
      },
    })))

    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(result.positions.value).toHaveLength(2)
    expect(result.positions.value[0]).toMatchObject({
      connectorId: 'metamorpho',
      protocol: 'Morpho Vaults',
      id: `metamorpho:${METAMORPHO_V1_VAULT}:supply`,
      owner: OWNER,
      ref: {
        vault: METAMORPHO_V1_VAULT,
        version: 'v1',
      },
      debt: null,
      collateral: expect.objectContaining({
        address: USDC,
        symbol: 'USDC',
        decimals: 6,
        amount: 100_000_000n,
        amountUsd: 100.02,
      }),
      vaultName: 'Steakhouse USDC',
      shares: 95_000_000_000_000_000_000n,
    })
    expect(result.positions.value[1]).toMatchObject({
      connectorId: 'metamorpho',
      id: `metamorpho:${METAMORPHO_V2_VAULT}:supply`,
      ref: {
        vault: METAMORPHO_V2_VAULT,
        version: 'v2',
      },
      debt: null,
      collateral: expect.objectContaining({
        amount: 4_200_000n,
        amountUsd: 4.2,
      }),
      vaultName: 'Hyperithm USDC Core',
    })
  })
})
