import { COLLATERAL_SWAP_WRAPPER_ABI } from '~/abis/cowswap-wrapper'
import { logWarn } from '~/utils/errorHandling'
import {
  type CowSwapCollateralSwapExecuteParams,
  type CowSwapOrderUid,
  getCowSwapChainConfig,
  buildCollateralSwapWrapperData,
  buildCowSwapAppData,
  buildCowSwapOrderTypedData,
  buildCowSwapOrderPayload,
} from '~/entities/cowswap'
import { useCowSwapExecutionCore } from './useCowSwapExecutionCore'

export const useCowSwapCollateralSwapExecution = () => {
  const core = useCowSwapExecutionCore()

  const executeAsync = async (params: CowSwapCollateralSwapExecuteParams): Promise<CowSwapOrderUid> => {
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
      // Approve fromVault shares → vaultRelayer (so settlement can pull vault shares from owner)
      core.status.value = 'approving_collateral'
      await core.safeApprove(params.sellToken, chainConfig.vaultRelayer, params.sellAmount)

      // Fetch EVC nonce + permit data, sign EVC permit
      core.status.value = 'signing_permit'

      const wrapperAddress = chainConfig.collateralSwapWrapper
      const wrapperParams = {
        owner: params.wrapper.owner,
        account: params.wrapper.account,
        deadline: BigInt(params.wrapper.deadline),
        fromVault: params.wrapper.fromVault,
        toVault: params.wrapper.toVault,
        fromAmount: params.wrapper.fromAmount,
        disableSourceCollateral: params.wrapper.disableSourceCollateral,
      }

      const { nonce, nonceNamespace, permitCalldata, evcAddress } = await core.fetchNonceAndPermitData(
        wrapperAddress,
        COLLATERAL_SWAP_WRAPPER_ABI,
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

      // Build CoW order + sign (settlement domain, kind='sell')
      core.status.value = 'signing_order'

      const wrapperData = buildCollateralSwapWrapperData(params.wrapper, permitSignature)
      const { appDataString, appDataHash } = buildCowSwapAppData(
        wrapperData,
        wrapperAddress,
        params.slippageBips,
        'euler_position_collateral_swap',
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
        kind: 'sell',
      })

      const orderSignature = await core.signOrderTypedData(orderTypedData)

      // Submit (eip712, from=owner)
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
      logWarn('cowswap/collateralSwap', wrapped)
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
