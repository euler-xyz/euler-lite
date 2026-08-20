import { getAddress, type Address, type Hash } from 'viem'
import { createOperationIntent, type CreateOperationIntentInput } from '~/features/transaction-ceremony/domain/factory'
import type { IntentConstraint, OperationIntent } from '~/features/transaction-ceremony/domain/intents'

export interface ConnectedOperationIntentInput {
  kind: CreateOperationIntentInput['kind']
  planner: CreateOperationIntentInput['planner']
  args: Readonly<Record<string, unknown>>
  source: string
  subAccounts?: readonly Address[]
  constraints?: readonly IntentConstraint[]
  intentId?: string
  revision?: number
  createdAt?: number
  quoteId?: string
  quoteCalldataDigest?: Hash
}

/**
 * Captures the effective account context at the trusted form action boundary.
 * The returned value is an immutable, serializable DTO; SDK accounts and Vue
 * refs in planner inputs are deliberately stripped by createOperationIntent.
 * Spy previews use the browsed chain until a wallet chain is available.
 */
export const useOperationIntentFactory = () => {
  const { effectiveAddress } = useEffectiveAddress()
  const { chainId: wagmiChainId } = useWagmi()
  const { chainId: browsedChainId } = useEulerAddresses()
  const chainId = computed(() => wagmiChainId.value ?? browsedChainId.value)

  const create = (input: ConnectedOperationIntentInput): Readonly<OperationIntent> => {
    if (!effectiveAddress.value || !chainId.value) throw new Error('Wallet is not connected')
    return createOperationIntent({
      ...input,
      account: getAddress(effectiveAddress.value),
      chainId: chainId.value,
    })
  }

  return { create }
}
