import { encodeFunctionData, type Address, type Hex, type StateOverride } from 'viem'
import { flattenBatchEntries, mergeStateOverrides, type EVCBatchItem, type EulerSDK, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'

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
