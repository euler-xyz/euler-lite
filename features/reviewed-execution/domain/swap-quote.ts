import { getAddress, type Address, type Hex } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from './canonical'

export interface IntentSwapToken {
  address: Address
  chainId: number
  decimals: number
  logoURI: string
  name: string
  symbol: string
}

export interface IntentSwapQuote {
  schemaVersion: 1
  amountIn: bigint
  amountInMax: bigint
  amountOut: bigint
  amountOutMin: bigint
  accountIn: Address
  accountOut: Address
  vaultIn: Address
  receiver: Address
  tokenIn: IntentSwapToken
  tokenOut: IntentSwapToken
  slippageBps: number
  swap: {
    swapperAddress: Address
    swapperData: Hex
    multicallItems: readonly {
      functionName: string
      args: readonly CanonicalValue[]
      data: Hex
    }[]
  }
  verify: {
    verifierAddress: Address
    verifierData: Hex
    type: 'skimMin' | 'debtMax' | 'transferMin'
    vault: Address
    account: Address
    amount: bigint
    deadline: number
  }
  route: readonly { providerName: string }[]
  providerData?: {
    quoteId?: string
    sellAmount?: bigint
    buyAmount?: bigint
    feeAmount?: bigint
  }
  transferOutputToReceiver?: boolean
}

const amount = (value: string | undefined, path: string) => {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${path} must be an unsigned integer string`)
  return BigInt(value)
}

const token = (value: SwapQuote['tokenIn']): IntentSwapToken => ({
  address: getAddress(value.address),
  chainId: value.chainId,
  decimals: value.decimals,
  logoURI: value.logoURI,
  name: value.name,
  symbol: value.symbol,
})

const optionalAmount = (value: string | undefined, path: string) => value === undefined ? undefined : amount(value, path)

/** Converts the API/SDK quote into the strict, integer-only reviewed execution DTO. */
export const normalizeIntentSwapQuote = (quote: SwapQuote): Readonly<IntentSwapQuote> => {
  const slippageBps = Math.round(quote.slippage * 100)
  if (!Number.isSafeInteger(slippageBps) || Math.abs(quote.slippage * 100 - slippageBps) > Number.EPSILON || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('Swap quote slippage cannot be represented exactly in basis points')
  }
  const providerData = quote.providerData
    ? {
        ...(quote.providerData.quoteId === undefined ? {} : { quoteId: String(quote.providerData.quoteId) }),
        ...(quote.providerData.sellAmount === undefined ? {} : { sellAmount: optionalAmount(quote.providerData.sellAmount, 'swapQuote.providerData.sellAmount')! }),
        ...(quote.providerData.buyAmount === undefined ? {} : { buyAmount: optionalAmount(quote.providerData.buyAmount, 'swapQuote.providerData.buyAmount')! }),
        ...(quote.providerData.feeAmount === undefined ? {} : { feeAmount: optionalAmount(quote.providerData.feeAmount, 'swapQuote.providerData.feeAmount')! }),
      }
    : undefined
  return deepFreezeSerializable({
    schemaVersion: 1,
    amountIn: amount(quote.amountIn, 'swapQuote.amountIn'),
    amountInMax: amount(quote.amountInMax, 'swapQuote.amountInMax'),
    amountOut: amount(quote.amountOut, 'swapQuote.amountOut'),
    amountOutMin: amount(quote.amountOutMin, 'swapQuote.amountOutMin'),
    accountIn: getAddress(quote.accountIn),
    accountOut: getAddress(quote.accountOut),
    vaultIn: getAddress(quote.vaultIn),
    receiver: getAddress(quote.receiver),
    tokenIn: token(quote.tokenIn),
    tokenOut: token(quote.tokenOut),
    slippageBps,
    swap: {
      swapperAddress: getAddress(quote.swap.swapperAddress),
      swapperData: quote.swap.swapperData,
      multicallItems: quote.swap.multicallItems.map(item => ({
        functionName: item.functionName,
        args: item.args.map((entry, index) => toCanonicalValue(entry, `swapQuote.swap.multicallItems.args[${index}]`)),
        data: item.data,
      })),
    },
    verify: {
      verifierAddress: getAddress(quote.verify.verifierAddress),
      verifierData: quote.verify.verifierData,
      type: quote.verify.type,
      vault: getAddress(quote.verify.vault),
      account: getAddress(quote.verify.account),
      amount: amount(quote.verify.amount, 'swapQuote.verify.amount'),
      deadline: quote.verify.deadline,
    },
    route: quote.route.map(hop => ({ providerName: hop.providerName })),
    ...(providerData ? { providerData } : {}),
    ...(quote.transferOutputToReceiver === undefined ? {} : { transferOutputToReceiver: quote.transferOutputToReceiver }),
  }) as Readonly<IntentSwapQuote>
}

/** Rehydrates only the public SDK fields after the DTO has passed its schema. */
export const rehydrateIntentSwapQuote = (quote: IntentSwapQuote): SwapQuote => ({
  amountIn: quote.amountIn.toString(),
  amountInMax: quote.amountInMax.toString(),
  amountOut: quote.amountOut.toString(),
  amountOutMin: quote.amountOutMin.toString(),
  accountIn: quote.accountIn,
  accountOut: quote.accountOut,
  vaultIn: quote.vaultIn,
  receiver: quote.receiver,
  tokenIn: { ...quote.tokenIn },
  tokenOut: { ...quote.tokenOut },
  slippage: quote.slippageBps / 100,
  swap: {
    swapperAddress: quote.swap.swapperAddress,
    swapperData: quote.swap.swapperData,
    multicallItems: quote.swap.multicallItems.map(item => ({ functionName: item.functionName, args: [...item.args], data: item.data })),
  },
  verify: {
    verifierAddress: quote.verify.verifierAddress,
    verifierData: quote.verify.verifierData,
    type: quote.verify.type as SwapQuote['verify']['type'],
    vault: quote.verify.vault,
    account: quote.verify.account,
    amount: quote.verify.amount.toString(),
    deadline: quote.verify.deadline,
  },
  route: quote.route.map(hop => ({ ...hop })),
  ...(quote.providerData
    ? {
        providerData: {
          ...(quote.providerData.quoteId === undefined ? {} : { quoteId: quote.providerData.quoteId }),
          ...(quote.providerData.sellAmount === undefined ? {} : { sellAmount: quote.providerData.sellAmount.toString() }),
          ...(quote.providerData.buyAmount === undefined ? {} : { buyAmount: quote.providerData.buyAmount.toString() }),
          ...(quote.providerData.feeAmount === undefined ? {} : { feeAmount: quote.providerData.feeAmount.toString() }),
        },
      }
    : {}),
  ...(quote.transferOutputToReceiver === undefined ? {} : { transferOutputToReceiver: quote.transferOutputToReceiver }),
})
