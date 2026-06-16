import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { getAddress } from 'viem'
import { useExternalMigrationPositions } from '~/composables/useExternalMigrationPositions'

const OWNER = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const MARKET_ID = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda'
const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const WETH = getAddress('0x4200000000000000000000000000000000000006')
const MORPHO_ORACLE = getAddress('0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4')
const MORPHO_IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

const market = {
  marketId: MARKET_ID,
  lltv: '860000000000000000',
  irmAddress: MORPHO_IRM,
  oracle: { address: MORPHO_ORACLE },
  loanAsset: { address: USDC, symbol: 'USDC', decimals: 6 },
  collateralAsset: { address: WETH, symbol: 'WETH', decimals: 18 },
  state: { borrowApy: '0.0449' },
}

describe('useExternalMigrationPositions', () => {
  let readContract: ReturnType<typeof vi.fn>
  let multicall: ReturnType<typeof vi.fn>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()

    readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'position') return [0n, 10n, 100n] as const
      if (functionName === 'market') return [0n, 0n, 25n, 10n, 0n, 0n] as const
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
          fallbackMarkets: { items: [market] },
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

  it('falls back to direct Morpho reads when the local client has no multicall address', async () => {
    const result = useExternalMigrationPositions()

    await flushPromises()
    await nextTick()

    expect(multicall).toHaveBeenCalled()
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(result.positions.value).toHaveLength(1)
    expect(result.positions.value[0]).toMatchObject({
      id: MARKET_ID,
      protocol: 'Morpho',
      owner: OWNER,
      debt: expect.objectContaining({
        address: USDC,
        amount: 25n,
        symbol: 'USDC',
      }),
      collateral: expect.objectContaining({
        address: WETH,
        amount: 100n,
        symbol: 'WETH',
      }),
    })
  })
})
