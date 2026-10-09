import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  InternalRpcError,
  RawContractError,
  erc20Abi,
  zeroAddress,
  type BaseError,
} from 'viem'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getServerSdk: vi.fn(),
  resolveTokenDecimals: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getQuery: (event: { query: Record<string, string> }) => event.query,
  setResponseHeader: vi.fn(),
}))
vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetchWithTimeout }))
vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: mocks.getServerSdk }))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  buildEulerSDK: async () => ({
    tokenlistService: {
      loadTokenlist: async (chainId: number) => (chainId === 1 ? [USDC] : []),
    },
  }),
}))

const token = (chainId: number, address: string, symbol: string, decimals: number | string) =>
  ({ chainId, address, name: symbol, symbol, decimals })

const USDC = token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6)
const FLUX = token(1, '0x720CD16b011b987Da3518fbf38c3071d4F0D1495', 'FLUX', 18)
const BASE_TOKEN = token(8453, '0x4200000000000000000000000000000000000006', 'WETH', 18)
const ETH = token(1, zeroAddress, 'ETH', 18)
const MALFORMED = token(1, '0x1234', 'BAD', 18)
const NO_CODE = token(1, '0x1111111111111111111111111111111111111111', 'NOCODE', 18)
const REVERTS = token(1, '0x2222222222222222222222222222222222222222', 'REVERT', 18)
const LODE = token(43114, '0xbBAAA0420D474B34Be197f95A323C2fF3829E811', 'LODE', '18')

const llamaByChain: Record<number, unknown[]> = {
  1: [ETH, MALFORMED, NO_CODE, REVERTS],
  43114: [LODE],
}
const onchain: Record<string, number> = {
  [USDC.address.toLowerCase()]: 6,
  [FLUX.address.toLowerCase()]: 8,
  [LODE.address.toLowerCase()]: 17,
}

const contractError = (cause: BaseError) =>
  new ContractFunctionExecutionError(cause, { abi: erc20Abi, functionName: 'decimals' })
const noContract = () => contractError(new ContractFunctionZeroDataError({ functionName: 'decimals' }))
const revertedInMulticall = () => contractError(new ContractFunctionRevertedError({
  abi: erc20Abi, functionName: 'decimals', cause: new RawContractError({ data: '0x' }),
}))
const rpcInternalError = () => contractError(new ContractFunctionRevertedError({
  abi: erc20Abi, functionName: 'decimals', message: 'internal error', cause: new InternalRpcError(new Error('internal error')),
}))

const readOnchain = async (_chainId: number, address: string) => {
  if (address.toLowerCase() === NO_CODE.address.toLowerCase()) throw noContract()
  if (address.toLowerCase() === REVERTS.address.toLowerCase()) throw revertedInMulticall()
  const decimals = onchain[address.toLowerCase()]
  if (decimals === undefined) throw new Error(`unexpected read ${address}`)
  return decimals
}

const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/token-list.get')
}

const bySymbol = (tokens: { symbol: string, decimals: number | string }[]) =>
  Object.fromEntries(tokens.map(t => [t.symbol, t.decimals]))

describe('/api/internal/token-list decimals', () => {
  beforeEach(() => {
    mocks.fetchWithTimeout.mockImplementation(async (url: string) => {
      const chainId = Number(url.match(/tokenlists-(\d+)\.json$/)?.[1])
      const body = url.includes('uniswap')
        ? { tokens: [FLUX, BASE_TOKEN] }
        : url.includes('tokenlists-') ? llamaByChain[chainId] ?? [] : {}
      return { ok: true, json: async () => body }
    })
    mocks.resolveTokenDecimals.mockImplementation(readOnchain)
    mocks.getServerSdk.mockResolvedValue({ tokenlistService: { resolveTokenDecimals: mocks.resolveTokenDecimals } })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('serves contract decimals for the requested chain and drops tokens without decimals()', async () => {
    const { refreshTokenList } = await importRoute()

    const tokens = await refreshTokenList(1)

    expect(bySymbol(tokens)).toEqual({ USDC: 6, FLUX: 8, ETH: 18 })
    expect(mocks.resolveTokenDecimals.mock.calls.map(([, address]) => address).sort()).toEqual(
      [USDC, FLUX, NO_CODE, REVERTS].map(t => t.address).sort(),
    )
  })

  it('serves LODE with its contract decimals through the handler', async () => {
    const { default: handler } = await importRoute()

    const { tokens } = await handler({ query: { chainId: '43114' } } as never)

    expect(tokens).toEqual([{ ...LODE, decimals: 17 }])
  })

  it('reads each token once per server process, including tokens without decimals()', async () => {
    const { refreshTokenList } = await importRoute()
    await refreshTokenList(1)
    mocks.resolveTokenDecimals.mockClear()

    const tokens = await refreshTokenList(1)

    expect(mocks.resolveTokenDecimals).not.toHaveBeenCalled()
    expect(bySymbol(tokens)).toEqual({ USDC: 6, FLUX: 8, ETH: 18 })
  })

  it('serves list decimals while reads fail and retries them on the next build', async () => {
    const { refreshTokenList } = await importRoute()
    mocks.resolveTokenDecimals.mockImplementation(async (chainId: number, address: string) => {
      if (address === FLUX.address) throw rpcInternalError()
      return readOnchain(chainId, address)
    })

    expect(bySymbol(await refreshTokenList(1))).toMatchObject({ FLUX: 18 })

    mocks.resolveTokenDecimals.mockClear()
    mocks.resolveTokenDecimals.mockImplementation(readOnchain)

    expect(bySymbol(await refreshTokenList(1))).toMatchObject({ FLUX: 8 })
    expect(mocks.resolveTokenDecimals.mock.calls.map(([, address]) => address)).toEqual([FLUX.address])
  })

  it('serves the list when the server SDK is unavailable', async () => {
    const { refreshTokenList } = await importRoute()
    mocks.getServerSdk.mockImplementation(() => {
      throw new Error('No RPC URL configured for chain 1')
    })

    expect(bySymbol(await refreshTokenList(1))).toEqual({ USDC: 6, FLUX: 18, ETH: 18, NOCODE: 18, REVERT: 18 })
  })
})
