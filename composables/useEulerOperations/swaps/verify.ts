import { encodeFunctionData } from 'viem'
import { adjustForInterest } from '../helpers'
import { swapVerifierAbi } from '~/entities/euler/abis'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'

export const getSwapInputAmount = (quote: SwapApiQuote, swapperMode: SwapperMode) => {
  const amountIn = BigInt(quote.amountIn || 0)
  const amountInMax = BigInt(quote.amountInMax || 0)
  if (swapperMode === SwapperMode.EXACT_IN) return amountIn
  return amountInMax > 0n ? amountInMax : amountIn
}

export const buildSwapVerifierData = ({
  quote,
  swapperMode,
  isRepay,
  targetDebt = 0n,
  currentDebt = 0n,
}: {
  quote: SwapApiQuote
  swapperMode: SwapperMode
  isRepay: boolean
  targetDebt?: bigint
  currentDebt?: bigint
}) => {
  let functionName: 'verifyAmountMinAndSkim' | 'verifyAmountMinAndTransfer' | 'verifyDebtMax'
  let amount: bigint

  if (isRepay) {
    functionName = 'verifyDebtMax'
    if (swapperMode === SwapperMode.TARGET_DEBT) {
      amount = targetDebt
    }
    else {
      amount = currentDebt - BigInt(quote.amountOutMin || 0)
      if (amount < 0n) amount = 0n
      amount = adjustForInterest(amount)
    }
  }
  else if (quote.verify.type === SwapVerificationType.TransferMin) {
    functionName = 'verifyAmountMinAndTransfer'
    amount = BigInt(quote.amountOutMin || 0)

    // verifyAmountMinAndTransfer(token, receiver, amountMin, deadline)
    // token = output token address, receiver = verify.vault (destination for the transfer)
    return encodeFunctionData({
      abi: swapVerifierAbi,
      functionName,
      args: [quote.tokenOut.address!, quote.verify.vault, amount, BigInt(quote.verify.deadline || 0)],
    })
  }
  else {
    functionName = 'verifyAmountMinAndSkim'
    amount = BigInt(quote.amountOutMin || 0)
  }

  // SkimMin: verifyAmountMinAndSkim(vault, receiver, amountMin, deadline)
  // DebtMax: verifyDebtMax(vault, account, amountMax, deadline)
  return encodeFunctionData({
    abi: swapVerifierAbi,
    functionName,
    args: [quote.verify.vault, quote.verify.account, amount, BigInt(quote.verify.deadline || 0)],
  })
}
