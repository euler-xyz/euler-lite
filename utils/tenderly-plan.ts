import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex, type StateOverride } from 'viem'
import { flattenBatchEntries, mergeStateOverrides, type EVCBatchItem, type EulerSDK, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { EoaRequest, SafeCall, SignatureSlot } from '~/features/reviewed-execution/domain/reviewed-execution'

export type TenderlyStateOverride = {
  address: Address
  stateDiff?: { slot: Hex, value: Hex }[]
}

export type TenderlySimulationPayload = {
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: string
  stateOverrides: TenderlyStateOverride[]
}

const reviewedRequestId = (request: EoaRequest | SafeCall) => 'requestId' in request ? request.requestId : request.callId

const decodeReviewedBatch = (request: EoaRequest | SafeCall): EVCBatchItem[] | undefined => {
  try {
    const decoded = decodeFunctionData({ abi: EVC_ABI, data: request.data })
    if (decoded.functionName !== 'batch') return undefined
    return decoded.args[0].map(item => ({
      targetContract: getAddress(item.targetContract),
      onBehalfOfAccount: getAddress(item.onBehalfOfAccount),
      value: item.value,
      data: item.data,
    }))
  }
  catch {
    return undefined
  }
}

/** Permit2 is represented by state overrides in Tenderly, so compare after removing only those declared slots. */
export const tenderlyPayloadMatchesReviewedRequests = ({
  payload,
  requests,
  signatureSlots,
  sdk,
}: {
  payload: TenderlySimulationPayload
  requests: readonly (EoaRequest | SafeCall)[]
  signatureSlots: readonly SignatureSlot[]
  sdk: Pick<EulerSDK, 'executionService'>
}): boolean => requests.some((request) => {
  if (getAddress(request.to) !== getAddress(payload.to)) return false
  if (request.value.toString() === payload.value && request.data === payload.data) return true

  const requestId = reviewedRequestId(request)
  const permit2Indexes = new Set(signatureSlots
    .filter(slot => slot.kind === 'permit2')
    .flatMap(slot => slot.insertionPoints
      .filter(point => point.requestId === requestId)
      .map(point => point.batchItemIndex)))
  if (!permit2Indexes.size) return false

  const items = decodeReviewedBatch(request)
  if (!items || [...permit2Indexes].some(index => !items[index])) return false
  const reviewedValue = items.reduce((sum, item) => sum + item.value, 0n)
  if (request.value !== reviewedValue) return false
  const simulatedItems = items.filter((_item, index) => !permit2Indexes.has(index))
  return sdk.executionService.encodeBatch(simulatedItems) === payload.data
    && simulatedItems.reduce((sum, item) => sum + item.value, 0n).toString() === payload.value
})

export const toTenderlyStateOverrides = (overrides: StateOverride): TenderlyStateOverride[] =>
  overrides.flatMap((entry) => {
    if (!entry.stateDiff?.length) return []
    return [{
      address: entry.address,
      stateDiff: entry.stateDiff.map(diff => ({
        slot: diff.slot,
        value: diff.value,
      })),
    }]
  })

const findFirstEvcBatch = (plan?: TransactionPlan) => plan?.find(item => item.type === 'evcBatch')

const findSingleContractCall = (plan: TransactionPlan) => {
  const contractCalls = plan.filter(item => item.type === 'contractCall')
  return contractCalls.length === 1 ? contractCalls[0] : undefined
}

export const buildTenderlySimulationPayload = async ({
  plan,
  owner,
  chainId,
  sdk,
  extraStateOverrides,
}: {
  plan: TransactionPlan
  owner: Address
  chainId?: number
  sdk: EulerSDK
  extraStateOverrides?: StateOverride
}): Promise<TenderlySimulationPayload | undefined> => {
  const batchItem = findFirstEvcBatch(plan)
  if (batchItem && batchItem.type === 'evcBatch') {
    if (!chainId) return undefined

    const items: EVCBatchItem[] = flattenBatchEntries(batchItem.items)
    const evcAddress = sdk.deploymentService.getDeployment(chainId).addresses.coreAddrs.evc
    const data = sdk.executionService.encodeBatch(items)
    const value = items.reduce((sum, it) => sum + it.value, 0n)
    const derivedStateOverrides = await sdk.executionService.deriveStateOverrides(
      chainId,
      owner,
      plan,
    )
    const stateOverrides = mergeStateOverrides([
      ...derivedStateOverrides,
      ...(extraStateOverrides ?? []),
    ])

    return {
      chainId,
      from: owner,
      to: evcAddress,
      data: data as Hex,
      value: value.toString(),
      stateOverrides: toTenderlyStateOverrides(stateOverrides),
    }
  }

  const contractCall = findSingleContractCall(plan)
  if (!contractCall) return undefined

  return {
    chainId: contractCall.chainId,
    from: owner,
    to: contractCall.to,
    data: encodeFunctionData({
      abi: contractCall.abi,
      functionName: contractCall.functionName,
      args: contractCall.args,
    }),
    value: contractCall.value.toString(),
    stateOverrides: toTenderlyStateOverrides(extraStateOverrides ?? []),
  }
}
