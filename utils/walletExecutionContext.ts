import { getAddress, type Address } from 'viem'

export interface WalletExecutionContext {
  account: Address
  chainId: number
}

export type WalletExecutionContextChange = 'account' | 'chain'

export class WalletExecutionContextChangedError extends Error {
  readonly kind: WalletExecutionContextChange

  constructor(kind: WalletExecutionContextChange) {
    super(kind === 'account'
      ? 'Wallet account changed during execution. Reconnect the original account and retry.'
      : 'Wallet network changed during execution. Switch back to the original network and retry.')
    this.name = 'WalletExecutionContextChangedError'
    this.kind = kind
  }
}

export const getWalletExecutionContextChange = ({
  expectedAccount,
  expectedChainId,
  currentAccount,
  currentChainId,
}: {
  expectedAccount?: string
  expectedChainId?: number
  currentAccount?: string
  currentChainId?: number
}): WalletExecutionContextChange | undefined => {
  const accountChanged = expectedAccount && currentAccount
    ? getAddress(currentAccount) !== getAddress(expectedAccount)
    : currentAccount !== expectedAccount

  if (accountChanged) return 'account'
  if (currentChainId !== expectedChainId) return 'chain'
  return undefined
}

export const assertWalletExecutionContext = ({
  expectedAccount,
  expectedChainId,
  currentAccount,
  currentChainId,
}: {
  expectedAccount: Address
  expectedChainId: number
  currentAccount?: Address
  currentChainId?: number
}) => {
  const change = getWalletExecutionContextChange({
    expectedAccount,
    expectedChainId,
    currentAccount,
    currentChainId,
  })
  if (change) throw new WalletExecutionContextChangedError(change)
}
