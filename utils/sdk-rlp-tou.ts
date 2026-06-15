import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import type {
  AddressOrAccount,
  BatchItemDescription,
  EulerPlugin,
  EVCBatchItem,
  TransactionPlan,
} from '@eulerxyz/euler-v2-sdk'
import { tosSignerWriteAbi } from '~/abis/tos'

type SignatureKey = `${number}:${string}`

interface StoredRlpTouSignature {
  tosMessage: string
  tosMessageHash: Hex
}

const signatures = new Map<SignatureKey, StoredRlpTouSignature>()

const keyFor = (chainId: number, account: Address): SignatureKey =>
  `${chainId}:${getAddress(account).toLowerCase()}`

export const setLiteRlpTouSignature = (args: {
  chainId: number
  account: Address
  tosMessage: string
  tosMessageHash: Hex
}) => {
  signatures.set(keyFor(args.chainId, args.account), {
    tosMessage: args.tosMessage,
    tosMessageHash: args.tosMessageHash,
  })
}

export const clearLiteRlpTouSignature = (args: { chainId: number, account: Address }) => {
  signatures.delete(keyFor(args.chainId, args.account))
}

const ownerOf = (account: AddressOrAccount): Address =>
  typeof account === 'string' ? getAddress(account) : getAddress(account.owner)

const prependToEveryEvcBatch = (plan: TransactionPlan, items: EVCBatchItem[]): TransactionPlan =>
  plan.map(entry =>
    entry.type === 'evcBatch'
      ? { ...entry, items: [...items, ...entry.items] }
      : entry,
  )

export const createLiteRlpTouPlugin = (): EulerPlugin => ({
  name: 'lite-rlp-tou',
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
