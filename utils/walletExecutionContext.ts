import { getAddress, type Address } from 'viem'

export interface WalletExecutionContext {
  account: Address
  chainId: number
}

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

/**
 * Guard for the irreversible broadcast boundary of a direct Safe-bundle flow.
 *
 * Account and chain checks cannot see a same-account connector switch, and the
 * confirm-entry checks run before authorization lookup, planning, preparation,
 * and simulation all await. The factory captures the connector identity when
 * the user confirms; the returned callback re-asserts the full reviewed
 * context — account, chain, Safe classification, and connector — immediately
 * before the proposal broadcast, so a wallet swapped during those awaits can
 * never submit the reviewed ceremony.
 */
export const createSafeBundleBroadcastGuard = ({
  expectedAccount,
  expectedChainId,
  currentAccount,
  currentChainId,
  isSafeWallet,
  connectorContextKey,
}: {
  expectedAccount: Address
  expectedChainId: number
  currentAccount: () => Address | undefined
  currentChainId: () => number | undefined
  isSafeWallet: () => boolean
  connectorContextKey: () => string | undefined
}): (() => void) => {
  const confirmedConnectorKey = connectorContextKey()
  return () => {
    assertWalletExecutionContext({
      expectedAccount,
      expectedChainId,
      currentAccount: currentAccount(),
      currentChainId: currentChainId(),
    })
    if (!isSafeWallet() || connectorContextKey() !== confirmedConnectorKey) {
      throw new Error('Wallet changed since review — please review the migration again.')
    }
  }
}
