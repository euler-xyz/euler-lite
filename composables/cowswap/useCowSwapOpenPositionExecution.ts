import { OPEN_POSITION_WRAPPER_ABI } from '~/abis/cowswap-wrapper'
import { logWarn } from '~/utils/errorHandling'
import {
  type CowSwapOpenPositionExecuteParams,
  type CowSwapOrderUid,
  getCowSwapChainConfig,
  buildOpenPositionWrapperData,
  buildOpenPositionQuoteAppData,
  buildCowSwapAppData,
  buildCowSwapOrderTypedData,
  buildCowSwapOrderPayload,
  validateCowSwapQuoteOrderAmounts,
} from '~/entities/cowswap'
import { useCowSwapExecutionCore } from './useCowSwapExecutionCore'

export const useCowSwapOpenPositionExecution = () => {
  const core = useCowSwapExecutionCore()

  const executeAsync = async (params: CowSwapOpenPositionExecuteParams): Promise<CowSwapOrderUid> => {
    const userAddress = core.requireWallet()
    const chainConfig = getCowSwapChainConfig(params.chainId)
    if (!chainConfig) throw new Error(`CowSwap not supported on chain ${params.chainId}`)
    core.configureCowApiCancellation({
      orderbookUrl: chainConfig.orderbookUrl,
      settlementContract: chainConfig.settlementContract,
      chainId: params.chainId,
    })

    if (params.sellAmount <= 0n) throw new Error('Sell amount must be greater than zero')
    if (params.buyAmount <= 0n) throw new Error('Buy amount must be greater than zero')

    core.error.value = null

    try {
      validateCowSwapQuoteOrderAmounts(params.quote, {
        sellAmount: params.sellAmount,
        buyAmount: params.buyAmount,
        slippage: params.slippage,
        slippageTarget: 'buyAmount',
        expectedSellAmount: params.expectedSellAmount,
        expectedAppData: params.expectedAppData,
        actualAppData: buildOpenPositionQuoteAppData(
          params.wrapper,
          chainConfig.openPositionWrapper,
          params.slippageBips,
        ),
      })

      // Approve collateral token → vault + sell token → vault relayer
      core.status.value = 'approving_collateral'

      if (params.wrapper.collateralAmount > 0n) {
        await core.safeApprove(params.collateralToken, params.wrapper.collateralVault, params.wrapper.collateralAmount)
      }
      await core.safeApprove(params.sellToken, chainConfig.vaultRelayer, params.sellAmount)

      // Fetch EVC nonce + permit data, sign EVC permit
      core.status.value = 'signing_permit'

      const wrapperAddress = chainConfig.openPositionWrapper
      const wrapperParams = {
        owner: params.wrapper.owner,
        account: params.wrapper.account,
        deadline: BigInt(params.wrapper.deadline),
        collateralVault: params.wrapper.collateralVault,
        borrowVault: params.wrapper.borrowVault,
        collateralAmount: params.wrapper.collateralAmount,
        borrowAmount: params.wrapper.borrowAmount,
      }

      const { nonce, nonceNamespace, permitCalldata, evcAddress } = await core.fetchNonceAndPermitData(
        wrapperAddress,
        OPEN_POSITION_WRAPPER_ABI,
        wrapperParams,
        params.chainId,
      )

      const permitSignature = await core.signEvcPermit({
        permitCalldata,
        chainId: params.chainId,
        evcAddress,
        wrapperAddress,
        nonceNamespace,
        nonce,
        deadline: params.wrapper.deadline,
      })

      // Build CoW order + sign
      core.status.value = 'signing_order'

      const wrapperData = buildOpenPositionWrapperData(params.wrapper, permitSignature)
      const { appDataString, appDataHash } = buildCowSwapAppData(
        wrapperData,
        wrapperAddress,
        params.slippageBips,
      )

      const orderTypedData = buildCowSwapOrderTypedData({
        chainId: params.chainId,
        settlementContract: chainConfig.settlementContract,
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        receiver: params.wrapper.account,
        sellAmount: params.sellAmount,
        buyAmount: params.buyAmount,
        validTo: params.validTo,
        appDataHash,
      })

      const orderSignature = await core.signOrderTypedData(orderTypedData)

      // Submit
      core.status.value = 'submitting'

      const payload = buildCowSwapOrderPayload(
        orderTypedData,
        orderSignature,
        userAddress,
        appDataString,
        appDataHash,
        { quoteId: params.quoteId },
      )

      return await core.submitAndFinalize(payload, chainConfig.orderbookUrl, params.chainId)
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      core.error.value = wrapped
      core.status.value = 'idle'
      logWarn('cowswap/openPosition', wrapped)
      throw wrapped
    }
  }

  return {
    executeAsync,
    cancelOrder: core.cancelOrder,
    reset: core.reset,
    status: core.status,
    orderUid: core.orderUid,
    isPending: core.isPending,
    explorerUrl: core.explorerUrl,
    error: core.error,
    locallyCancelled: core.locallyCancelled,
    cancellationStatus: core.cancellationStatus,
    cancellationMode: core.cancelMode,
  }
}
