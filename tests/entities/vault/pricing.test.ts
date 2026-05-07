import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BaseError, HttpRequestError, TimeoutError } from 'viem'

const readContractMock = vi.fn()

vi.mock('~/utils/public-client', () => ({
  getPublicClient: () => ({ readContract: readContractMock }),
}))

const RPC_URL = 'https://example.test/rpc'
const LENS = '0x000000000000000000000000000000000000DEAD'
const ASSET = '0x000000000000000000000000000000000000BEEF'

describe('resolveAssetPriceInfo cache behaviour', () => {
  beforeEach(async () => {
    const { clearPriceCaches } = await import('~/entities/vault/pricing')
    clearPriceCaches()
    readContractMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('caches a successful price and avoids a second RPC call', async () => {
    readContractMock.mockResolvedValue({
      queryFailure: false,
      amountIn: 10n ** 18n,
      amountOutAsk: 100n,
      amountOutBid: 99n,
      amountOutMid: 100n,
      timestamp: 1n,
      oracle: '0x0000000000000000000000000000000000000001',
    })

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const first = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)
    const second = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)

    expect(first?.amountOutMid).toBe(100n)
    expect(second?.amountOutMid).toBe(100n)
    expect(readContractMock).toHaveBeenCalledTimes(1)
  })

  it('caches queryFailure: true (contract-level no-price) so the call is not retried', async () => {
    readContractMock.mockResolvedValue({
      queryFailure: true,
      amountIn: 10n ** 18n,
      amountOutAsk: 0n,
      amountOutBid: 0n,
      amountOutMid: 0n,
      timestamp: 0n,
      oracle: '0x0000000000000000000000000000000000000001',
    })

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const first = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)
    const second = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(readContractMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache when the failure is a transport error (HTTP 5xx)', async () => {
    const transport = new HttpRequestError({
      url: 'https://rpc.ankr.com/tac',
      status: 503,
      body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] },
      details: 'Service Unavailable',
    })
    readContractMock.mockRejectedValueOnce(transport)
    readContractMock.mockResolvedValueOnce({
      queryFailure: false,
      amountIn: 10n ** 18n,
      amountOutAsk: 200n,
      amountOutBid: 199n,
      amountOutMid: 200n,
      timestamp: 1n,
      oracle: '0x0000000000000000000000000000000000000001',
    })

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const first = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)
    const second = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)

    expect(first).toBeUndefined()
    expect(second?.amountOutMid).toBe(200n)
    expect(readContractMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache when the failure is a timeout', async () => {
    const timeout = new TimeoutError({
      body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] },
      url: 'https://rpc.example/tac',
    })
    readContractMock.mockRejectedValueOnce(timeout)
    readContractMock.mockResolvedValueOnce({
      queryFailure: false,
      amountIn: 10n ** 18n,
      amountOutAsk: 50n,
      amountOutBid: 49n,
      amountOutMid: 50n,
      timestamp: 1n,
      oracle: '0x0000000000000000000000000000000000000001',
    })

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const first = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)
    const second = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)

    expect(first).toBeUndefined()
    expect(second?.amountOutMid).toBe(50n)
    expect(readContractMock).toHaveBeenCalledTimes(2)
  })

  it('caches non-transport errors (e.g. unexpected revert) so we do not hammer the RPC', async () => {
    const revert = new BaseError('unexpected revert', { name: 'ContractFunctionRevertedError' })
    readContractMock.mockRejectedValue(revert)

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const first = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)
    const second = await resolveAssetPriceInfo(RPC_URL, LENS, ASSET)

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(readContractMock).toHaveBeenCalledTimes(1)
  })

  it('concurrent calls during a transport failure share one in-flight request', async () => {
    const transport = new HttpRequestError({
      url: 'https://rpc.example/tac',
      status: 503,
      body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] },
      details: 'Service Unavailable',
    })
    readContractMock.mockRejectedValueOnce(transport)

    const { resolveAssetPriceInfo } = await import('~/entities/vault/pricing')
    const [a, b, c] = await Promise.all([
      resolveAssetPriceInfo(RPC_URL, LENS, ASSET),
      resolveAssetPriceInfo(RPC_URL, LENS, ASSET),
      resolveAssetPriceInfo(RPC_URL, LENS, ASSET),
    ])

    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(c).toBeUndefined()
    expect(readContractMock).toHaveBeenCalledTimes(1)
  })
})
