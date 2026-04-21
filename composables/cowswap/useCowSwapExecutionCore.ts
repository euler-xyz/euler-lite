import { ref, computed } from 'vue'
import type { Address, Hex } from 'viem'
import { useSignTypedData, useWriteContract } from '@wagmi/vue'
import { EVC_ABI } from '~/abis/evc'
import { logWarn } from '~/utils/errorHandling'
import { getAddressPrefix } from '~/utils/subgraph'
import {
  type CowSwapExecutionStatus,
  type CowSwapOrderUid,
  buildEvcPermitTypedData,
  normalizeCowSignature,
  computeNonceNamespace,
  submitCowSwapOrder,
  cancelCowSwapOrder,
  type CowSwapOrderPayload,
} from '~/entities/cowswap'

export const useCowSwapExecutionCore = () => {
  const { address } = useWagmi()
  const { eulerCoreAddresses } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const { prepareTokenApproval } = useEulerOperations()

  const status = ref<CowSwapExecutionStatus>('idle')
  const orderUid = ref<CowSwapOrderUid | undefined>()
  const submissionChainId = ref<number | undefined>()
  const error = ref<Error | null>(null)
  const locallyCancelled = ref(false)
  const permitCancellation = ref<{
    evcAddress: Address
    addressPrefix: Hex
    nonceNamespace: bigint
    nonce: bigint
  } | undefined>()
  const cancelMode = ref<'cow-api' | 'evc-permit' | undefined>()
  const cowApiCancellation = ref<{
    orderbookUrl: string
    settlementContract: Address
    chainId: number
  } | undefined>()

  const isPending = computed(() => status.value !== 'idle' && status.value !== 'submitted')
  const explorerUrl = computed(() => {
    if (!orderUid.value || !submissionChainId.value) return undefined
    return `https://explorer.cow.fi/orders/${orderUid.value}`
  })

  const requireWallet = () => {
    const userAddress = address.value
    if (!userAddress) throw new Error('Wallet not connected')
    return userAddress as Address
  }

  const requireEvc = () => {
    const evcAddress = eulerCoreAddresses.value?.evc as Address | undefined
    if (!evcAddress) throw new Error('EVC address not available')
    return evcAddress
  }

  const requireRpc = () => {
    const client = rpcClient.value
    if (!client) throw new Error('RPC client not available')
    return client
  }

  /** Execute on-chain approval steps (supports USDT-safe reset pattern). */
  const safeApprove = async (token: Address, spender: Address, amount: bigint) => {
    const userAddress = requireWallet()
    const client = requireRpc()

    const { steps } = await prepareTokenApproval({
      assetAddr: token,
      spenderAddr: spender,
      userAddr: userAddress,
      amount,
      directApproval: true,
    })

    for (const step of steps) {
      const tx = await writeContractAsync({
        address: step.to as Address,
        abi: step.abi,
        functionName: step.functionName,
        args: step.args as unknown[],
      })
      await client.waitForTransactionReceipt({ hash: tx })
    }
  }

  const writeContractAndWait = async (params: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: unknown[]
  }): Promise<Hex> => {
    const client = requireRpc()
    const tx = await writeContractAsync({
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args ?? [],
    })
    await client.waitForTransactionReceipt({ hash: tx })
    return tx
  }

  /** Fetch EVC nonce and call wrapper.encodePermitData(). */
  const fetchNonceAndPermitData = async (
    wrapperAddress: Address,
    wrapperAbi: readonly unknown[],
    wrapperParams: unknown,
    flowChainId: number,
  ) => {
    const userAddress = requireWallet()
    const evcAddress = requireEvc()
    const client = requireRpc()

    const nonceNamespace = computeNonceNamespace(wrapperAddress)
    const addressPrefix = getAddressPrefix(userAddress) as Hex

    const nonce = await client.readContract({
      address: evcAddress,
      abi: EVC_ABI,
      functionName: 'getNonce',
      args: [addressPrefix, nonceNamespace],
    }) as bigint

    const permitCalldata = await client.readContract({
      address: wrapperAddress,
      abi: wrapperAbi,
      functionName: 'encodePermitData',
      args: [wrapperParams],
    }) as Hex

    permitCancellation.value = { evcAddress, addressPrefix, nonceNamespace, nonce }

    return { nonce, nonceNamespace, permitCalldata, evcAddress, chainId: flowChainId }
  }

  /** Sign the EVC permit typed data. */
  const signEvcPermit = async (params: {
    permitCalldata: Hex
    chainId: number
    evcAddress: Address
    wrapperAddress: Address
    nonceNamespace: bigint
    nonce: bigint
    deadline: number
  }): Promise<Hex> => {
    const userAddress = requireWallet()

    const permitTypedData = buildEvcPermitTypedData({
      chainId: params.chainId,
      evcAddress: params.evcAddress,
      signer: userAddress,
      sender: params.wrapperAddress,
      nonceNamespace: params.nonceNamespace,
      nonce: params.nonce,
      deadline: params.deadline,
      data: params.permitCalldata,
    })

    return await signTypedDataAsync({
      domain: permitTypedData.domain,
      types: permitTypedData.types,
      primaryType: permitTypedData.primaryType,
      message: permitTypedData.message,
    }) as Hex
  }

  /** Sign EIP-712 typed data (for CoW order). */
  const signOrderTypedData = async (typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<string> => {
    const signature = await signTypedDataAsync({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    }) as string

    return normalizeCowSignature(signature as Hex)
  }

  /** Submit the order payload to the CoW API. */
  const submitAndFinalize = async (
    payload: CowSwapOrderPayload,
    orderbookUrl: string,
    flowChainId: number,
  ): Promise<CowSwapOrderUid> => {
    const uid = await submitCowSwapOrder(payload, orderbookUrl)
    orderUid.value = uid
    submissionChainId.value = flowChainId
    status.value = 'submitted'
    return uid
  }

  const configureCowApiCancellation = (params: {
    orderbookUrl: string
    settlementContract: Address
    chainId: number
  }) => {
    cancelMode.value = 'cow-api'
    cowApiCancellation.value = params
  }

  const configurePermitCancellation = () => {
    cancelMode.value = 'evc-permit'
    cowApiCancellation.value = undefined
  }

  const cancelOrder = async (): Promise<void> => {
    const uid = orderUid.value
    if (!uid) throw new Error('No order to cancel')

    error.value = null
    const previousStatus = status.value
    status.value = 'cancelling'

    try {
      if (cancelMode.value === 'cow-api') {
        const config = cowApiCancellation.value
        if (!config) throw new Error('CoW API cancellation data not available')

        await cancelCowSwapOrder({
          orderUid: uid,
          orderbookUrl: config.orderbookUrl,
          settlementContract: config.settlementContract,
          chainId: config.chainId,
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
      else {
        const permit = permitCancellation.value
        if (!permit) throw new Error('Permit cancellation data not available')

        const client = requireRpc()
        const currentNonce = await client.readContract({
          address: permit.evcAddress,
          abi: EVC_ABI,
          functionName: 'getNonce',
          args: [permit.addressPrefix, permit.nonceNamespace],
        }) as bigint

        if (currentNonce <= permit.nonce) {
          await writeContractAndWait({
            address: permit.evcAddress,
            abi: EVC_ABI,
            functionName: 'setNonce',
            args: [permit.addressPrefix, permit.nonceNamespace, permit.nonce + 1n],
          })
        }
      }

      locallyCancelled.value = true
      status.value = 'submitted'
    }
    catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      error.value = wrapped
      status.value = previousStatus
      logWarn('cowswap/cancelOrder', wrapped)
      throw wrapped
    }
  }

  const reset = () => {
    status.value = 'idle'
    orderUid.value = undefined
    submissionChainId.value = undefined
    error.value = null
    locallyCancelled.value = false
    permitCancellation.value = undefined
    cancelMode.value = undefined
    cowApiCancellation.value = undefined
  }

  return {
    // State
    status,
    orderUid,
    submissionChainId,
    error,
    locallyCancelled,
    // Computed
    isPending,
    explorerUrl,
    // Lifecycle
    cancelOrder,
    reset,
    // Helpers for flow composables
    requireWallet,
    requireEvc,
    requireRpc,
    safeApprove,
    writeContractAndWait,
    fetchNonceAndPermitData,
    signEvcPermit,
    signOrderTypedData,
    submitAndFinalize,
    configureCowApiCancellation,
    configurePermitCancellation,
  }
}
