import { getAddress, type Address } from 'viem'

export class WalletExecutionContextChangedError extends Error {
  readonly kind: 'account' | 'chain'

  constructor(kind: 'account' | 'chain') {
    super(kind === 'account'
      ? 'Wallet account changed during execution. Reconnect the original account and retry.'
      : 'Wallet network changed during execution. Switch back to the original network and retry.')
    this.name = 'WalletExecutionContextChangedError'
    this.kind = kind
  }
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
  if (!currentAccount || getAddress(currentAccount) !== getAddress(expectedAccount)) {
    throw new WalletExecutionContextChangedError('account')
  }
  if (currentChainId !== expectedChainId) {
    throw new WalletExecutionContextChangedError('chain')
  }
}
