import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { submitCowSwapOrder, cancelCowSwapOrder } from '~/entities/cowswap/order-submit'
import type { CowSwapOrderPayload } from '~/entities/cowswap/types'
import { logger } from '~/utils/logger'

const cancelParams = {
  orderUid: '0xorderuid',
  orderbookUrl: 'https://api.cow.fi/mainnet',
  settlementContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  chainId: 1,
  signTypedData: vi.fn(async () => '0xsignature' as Hex),
} as const

const orderPayload: CowSwapOrderPayload = {
  sellToken: '0x1111111111111111111111111111111111111111',
  buyToken: '0x2222222222222222222222222222222222222222',
  from: '0x3333333333333333333333333333333333333333',
  receiver: '0x4444444444444444444444444444444444444444',
  sellAmount: '1000',
  buyAmount: '900',
  feeAmount: '0',
  kind: 'sell',
  partiallyFillable: false,
  validTo: 1234567890,
  sellTokenBalance: 'erc20',
  buyTokenBalance: 'erc20',
  signature: '0xsignature',
  signingScheme: 'eip712',
  onchainOrder: false,
  appData: '{}',
  appDataHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
  quoteId: 123,
}

describe('submitCowSwapOrder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('logs orders accepted by the CoW API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ uid: '0xorderuid' }),
    })))
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})

    await expect(submitCowSwapOrder(orderPayload, 'https://api.cow.fi/mainnet')).resolves.toBe('0xorderuid')

    expect(infoSpy).toHaveBeenCalledWith(
      {
        ctx: 'cowswap/orderSubmit',
        orderbookUrl: 'https://api.cow.fi/mainnet',
        orderUid: '0xorderuid',
        order: orderPayload,
      },
      'submitted CoW order',
    )
  })
})

describe('cancelCowSwapOrder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    cancelParams.signTypedData.mockClear()
  })

  it('throws a concise cancel API error from a structured response body', async () => {
    const longDescription = 'This order cannot be cancelled because '.repeat(20)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        errorType: 'OrderNotCancellable',
        description: longDescription,
      }),
    })))

    await expect(cancelCowSwapOrder(cancelParams)).rejects.toThrow(
      /^CoW cancel API 400: OrderNotCancellable: This order cannot be cancelled because /,
    )

    const err = await cancelCowSwapOrder(cancelParams).catch(error => error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message.length).toBeLessThan(230)
  })
})
