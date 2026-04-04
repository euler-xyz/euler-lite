import { ref, computed } from 'vue'
import { erc20Abi, type Address, type Hex } from 'viem'
import { useSignTypedData, useWriteContract } from '@wagmi/vue'
import { EVC_ABI } from '~/abis/evc'
import { OPEN_POSITION_WRAPPER_ABI } from '~/abis/cowswap-wrapper'
import { logWarn } from '~/utils/errorHandling'
import { getAddressPrefix } from '~/utils/subgraph'
import {
  type CowSwapExecutionStatus,
  type CowSwapExecuteParams,
  type CowSwapOrderUid,
  getCowSwapChainConfig,
  buildCowSwapWrapperData,
  buildCowSwapAppData,
  buildCowSwapOrderTypedData,
  buildCowSwapOrderPayload,
  buildEvcPermitTypedData,
  computeNonceNamespace,
  submitCowSwapOrder,
  cancelCowSwapOrder,
} from '~/entities/cowswap'

export const useCowSwapExecution = () => {
  const { address } = useWagmi()
  const { eulerCoreAddresses, chainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  const status = ref<CowSwapExecutionStatus>('idle')
  const orderUid = ref<CowSwapOrderUid | undefined>()
  const submissionChainId = ref<number | undefined>()
  const error = ref<Error | null>(null)

  const isPending = computed(() => status.value !== 'idle' && status.value !== 'submitted')
  const explorerUrl = computed(() => {
    if (!orderUid.value || !submissionChainId.value) return undefined
    const config = getCowSwapChainConfig(submissionChainId.value)
    // Barn (staging) orders won't appear on the production explorer
    const base = config?.orderbookUrl?.includes('barn')
      ? 'https://barn.explorer.cow.fi'
      : 'https://explorer.cow.fi'
    return `${base}/orders/${orderUid.value}`
  })

  const executeAsync = async (params: CowSwapExecuteParams): Promise<CowSwapOrderUid> => {
    const userAddress = address.value
    if (!userAddress) throw new Error('Wallet not connected')

    const evcAddress = eulerCoreAddresses.value?.evc as Address | undefined
    if (!evcAddress) throw new Error('EVC address not available')

    const client = rpcClient.value
    if (!client) throw new Error('RPC client not available')

    const chainConfig = getCowSwapChainConfig(params.chainId)
    if (!chainConfig) throw new Error(`CowSwap not supported on chain ${params.chainId}`)

    if (params.sellAmount <= 0n) throw new Error('Sell amount must be greater than zero')
    if (params.buyAmount <= 0n) throw new Error('Buy amount must be greater than zero')

    error.value = null

    try {
      // Step 1: Approve collateral token to collateral vault (exact amount, if needed)
      status.value = 'approving_collateral'

      if (params.wrapper.collateralAmount > 0n) {
        const allowance = await client.readContract({
          address: params.collateralToken,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [userAddress as Address, params.wrapper.collateralVault],
        })

        if (allowance < params.wrapper.collateralAmount) {
          const approveTx = await writeContractAsync({
            address: params.collateralToken,
            abi: erc20Abi,
            functionName: 'approve',
            args: [params.wrapper.collateralVault, params.wrapper.collateralAmount],
          })
          await client.waitForTransactionReceipt({ hash: approveTx })
        }
      }

      // Step 2: Fetch EVC nonce for permit
      status.value = 'signing_permit'

      const wrapperAddress = chainConfig.openPositionWrapper
      const nonceNamespace = computeNonceNamespace(wrapperAddress)

      const addressPrefix = getAddressPrefix(userAddress) as Hex

      const nonce = await client.readContract({
        address: evcAddress,
        abi: EVC_ABI,
        functionName: 'getNonce',
        args: [addressPrefix, nonceNamespace],
      }) as bigint

      // Step 3: Get permit calldata from wrapper contract
      const wrapperParams = {
        owner: params.wrapper.owner,
        account: params.wrapper.account,
        deadline: BigInt(params.wrapper.deadline),
        collateralVault: params.wrapper.collateralVault,
        borrowVault: params.wrapper.borrowVault,
        collateralAmount: params.wrapper.collateralAmount,
        borrowAmount: params.wrapper.borrowAmount,
      }

      const permitCalldata = await client.readContract({
        address: wrapperAddress,
        abi: OPEN_POSITION_WRAPPER_ABI,
        functionName: 'encodePermitData',
        args: [wrapperParams],
      }) as Hex

      // Step 4: Sign EVC permit
      const permitTypedData = buildEvcPermitTypedData({
        chainId: params.chainId,
        evcAddress,
        signer: userAddress as Address,
        sender: wrapperAddress,
        nonceNamespace,
        nonce,
        deadline: params.wrapper.deadline,
        data: permitCalldata,
      })

      const permitSignature = await signTypedDataAsync({
        domain: permitTypedData.domain,
        types: permitTypedData.types,
        primaryType: permitTypedData.primaryType,
        message: permitTypedData.message,
      }) as Hex

      // Step 5: Build CoW order with permit embedded in appData
      status.value = 'signing_order'

      const wrapperData = buildCowSwapWrapperData(params.wrapper, permitSignature)
      const { appDataString, appDataHash } = buildCowSwapAppData(wrapperData, wrapperAddress)

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

      // Step 6: Sign CoW order
      const orderSignature = await signTypedDataAsync({
        domain: orderTypedData.domain,
        types: orderTypedData.types,
        primaryType: orderTypedData.primaryType,
        message: orderTypedData.message,
      })

      // Step 7: Submit to CoW API
      status.value = 'submitting'

      const payload = buildCowSwapOrderPayload(
        orderTypedData,
        orderSignature,
        userAddress as Address,
        appDataString,
        appDataHash,
      )

      const uid = await submitCowSwapOrder(payload, chainConfig.orderbookUrl)

      orderUid.value = uid
      submissionChainId.value = params.chainId
      status.value = 'submitted'

      return uid
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      error.value = wrapped
      status.value = 'idle'
      logWarn('cowswap/execution', wrapped)
      throw wrapped
    }
  }

  const cancelOrder = async (): Promise<void> => {
    const uid = orderUid.value
    if (!uid) throw new Error('No order to cancel')

    const cancelChainId = submissionChainId.value ?? chainId.value ?? 0
    const config = getCowSwapChainConfig(cancelChainId)
    if (!config) throw new Error('Chain not supported')

    error.value = null

    try {
      await cancelCowSwapOrder({
        orderUid: uid,
        orderbookUrl: config.orderbookUrl,
        settlementContract: config.settlementContract,
        chainId: cancelChainId,
        signTypedData: async (params) => {
          return await signTypedDataAsync({
            domain: params.domain as Record<string, unknown>,
            types: params.types as Record<string, unknown>,
            primaryType: params.primaryType,
            message: params.message as Record<string, unknown>,
          }) as Hex
        },
      })
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      error.value = wrapped
      logWarn('cowswap/cancelOrder', wrapped)
      throw wrapped
    }
  }

  const reset = () => {
    status.value = 'idle'
    orderUid.value = undefined
    submissionChainId.value = undefined
    error.value = null
  }

  return {
    executeAsync,
    cancelOrder,
    reset,
    status,
    orderUid,
    isPending,
    explorerUrl,
    error,
  }
}
