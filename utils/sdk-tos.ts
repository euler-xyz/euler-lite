import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import type {
  AddressOrAccount,
  BatchItemDescription,
  EulerPlugin,
  EVCBatchItem,
  TransactionPlan,
  TransactionPlanPrepared,
} from '@eulerxyz/euler-v2-sdk'
import { tosSignerWriteAbi } from '~/abis/tos'

type SignatureKey = `${number}:${string}`

interface StoredTosSignature {
  tosMessage: string
  tosMessageHash: Hex
}

const signatures = new Map<SignatureKey, StoredTosSignature>()
const preparedPlanContextVersions = new WeakMap<TransactionPlanPrepared, number>()
let tosContextVersion = 0

const keyFor = (chainId: number, account: Address): SignatureKey =>
  `${chainId}:${getAddress(account).toLowerCase()}`

export const setLiteTosSignature = (args: {
  chainId: number
  account: Address
  tosMessage: string
  tosMessageHash: Hex
}) => {
  const key = keyFor(args.chainId, args.account)
  const current = signatures.get(key)
  if (
    current?.tosMessage === args.tosMessage
    && current.tosMessageHash === args.tosMessageHash
  ) return
  signatures.set(key, {
    tosMessage: args.tosMessage,
    tosMessageHash: args.tosMessageHash,
  })
  tosContextVersion += 1
}

export const clearLiteTosSignature = (args: { chainId: number, account: Address }) => {
  if (signatures.delete(keyFor(args.chainId, args.account))) {
    tosContextVersion += 1
  }
}

export const getLiteTosContextVersion = (): number => tosContextVersion

export const bindLiteTosContextToPreparedPlan = (
  prepared: TransactionPlanPrepared,
  contextVersion = getLiteTosContextVersion(),
): TransactionPlanPrepared => {
  preparedPlanContextVersions.set(prepared, contextVersion)
  return prepared
}

export const assertPreparedPlanLiteTosContextCurrent = (
  prepared: TransactionPlanPrepared,
) => {
  const preparedVersion = preparedPlanContextVersions.get(prepared)
  if (
    preparedVersion !== undefined
    && preparedVersion !== getLiteTosContextVersion()
  ) {
    throw new Error('Terms of Use context changed after this transaction was prepared. Prepare and review it again.')
  }
}

const ownerOf = (account: AddressOrAccount): Address =>
  typeof account === 'string' ? getAddress(account) : getAddress(account.owner)

const prependToEveryEvcBatch = (plan: TransactionPlan, items: EVCBatchItem[]): TransactionPlan =>
  plan.map(entry =>
    entry.type === 'evcBatch'
      ? { ...entry, items: [...items, ...entry.items] }
      : entry,
  )

export const createLiteTosPlugin = (): EulerPlugin => ({
  name: 'lite-tos',
  async processPlan(plan, account, chainId, sdk) {
    const owner = ownerOf(account)
    const stored = signatures.get(keyFor(chainId, owner))
    if (!stored) return plan

    const tosSigner = sdk.deploymentService.getDeployment(chainId)?.addresses?.peripheryAddrs?.termsOfUseSigner
    if (!tosSigner) return plan

    const tosItem: EVCBatchItem = {
      targetContract: tosSigner,
      onBehalfOfAccount: owner,
      value: 0n,
      data: encodeFunctionData({
        abi: tosSignerWriteAbi,
        functionName: 'signTermsOfUse',
        args: [stored.tosMessage, stored.tosMessageHash],
      }) as Hex,
    }
    return prependToEveryEvcBatch(plan, [tosItem])
  },
  decodeBatchItem(item): BatchItemDescription | null {
    try {
      const decoded = decodeFunctionData({ abi: tosSignerWriteAbi, data: item.data })
      if (decoded.functionName !== 'signTermsOfUse') return null
      const [tosMessage, tosMessageHash] = decoded.args as [string, Hex]
      return {
        targetContract: item.targetContract,
        onBehalfOfAccount: item.onBehalfOfAccount,
        functionName: 'signTermsOfUse',
        args: { tosMessage, tosMessageHash },
      }
    }
    catch {
      return null
    }
  },
})
