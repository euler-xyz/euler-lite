import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { cancelCowSwapOrder } from '~/entities/cowswap/order-submit'

const cancelParams = {
  orderUid: '0xorderuid',
  orderbookUrl: 'https://api.cow.fi/mainnet',
  settlementContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
  chainId: 1,
  signTypedData: vi.fn(async () => '0xsignature' as Hex),
} as const

describe('cancelCowSwapOrder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
