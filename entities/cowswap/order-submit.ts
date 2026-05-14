import type { Address, Hex } from 'viem'
import { logger } from '~/utils/logger'
import type { CowSwapOrderPayload, CowSwapOrderUid } from './types'

const MAX_CANCEL_ERROR_MESSAGE_LENGTH = 180

const coerceOrderUid = (data: unknown): CowSwapOrderUid => {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object' && 'uid' in data) {
    const uid = (data as { uid?: unknown }).uid
    if (typeof uid === 'string') return uid
  }
  throw new Error('Unexpected CoW order response format')
}

const truncateErrorMessage = (message: string): string => {
  if (message.length <= MAX_CANCEL_ERROR_MESSAGE_LENGTH) return message
  return `${message.slice(0, MAX_CANCEL_ERROR_MESSAGE_LENGTH).trimEnd()}...`
}

const extractCowSwapErrorMessage = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const type = typeof record.errorType === 'string' ? record.errorType : undefined
      const detail = [record.description, record.message, record.error]
        .find(value => typeof value === 'string') as string | undefined
      return [type, detail].filter(Boolean).join(': ') || text
    }
  }
  catch {
    // Fall back to the raw response body below.
  }

  return text
}

export const submitCowSwapOrder = async (
  payload: CowSwapOrderPayload,
  orderbookUrl: string,
): Promise<CowSwapOrderUid> => {
  const res = await fetch(`${orderbookUrl}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CoW API ${res.status}: ${text.slice(0, 500)}`)
  }

  const data: unknown = await res.json()
  const uid = coerceOrderUid(data)
  logger.info(
    {
      ctx: 'cowswap/orderSubmit',
      orderbookUrl,
      orderUid: uid,
      order: payload,
    },
    'submitted CoW order',
  )
  return uid
}

// EIP-712 typed data for order cancellation
const COW_CANCEL_TYPES = {
  OrderCancellations: [
    { name: 'orderUids', type: 'bytes[]' },
  ],
} as const

export type CancelCowSwapOrderParams = {
  orderUid: CowSwapOrderUid
  orderbookUrl: string
  settlementContract: Address
  chainId: number
  signTypedData: (params: { domain: object, types: object, primaryType: string, message: object }) => Promise<Hex>
}

export const cancelCowSwapOrder = async (params: CancelCowSwapOrderParams): Promise<void> => {
  const domain = {
    name: 'Gnosis Protocol',
    version: 'v2',
    chainId: params.chainId,
    verifyingContract: params.settlementContract,
  }

  const message = {
    orderUids: [params.orderUid],
  }

  const signature = await params.signTypedData({
    domain,
    types: COW_CANCEL_TYPES,
    primaryType: 'OrderCancellations',
    message,
  })

  const res = await fetch(`${params.orderbookUrl}/api/v1/orders`, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      orderUids: [params.orderUid],
      signature,
      signingScheme: 'eip712',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CoW cancel API ${res.status}: ${truncateErrorMessage(extractCowSwapErrorMessage(text))}`)
  }
}
