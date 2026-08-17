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
 * Account and chain checks cannot see a same-account connector switch, and
 * confirmation awaits (pending restoration, authorization lookup, planning,
 * preparation, simulation) all yield before the proposal broadcast. Snapshotting
 * the connector inside the confirmation flow would accept a connector swapped
 * during an earlier await as the baseline, so `expectedConnectorKey` must be
 * the key the reviewed preview captured when it was built. The returned
 * callback re-asserts the full reviewed context — account, chain, Safe
 * classification, and connector — immediately before the broadcast, and fails
 * closed when the review captured no connector at all.
 */
export const createSafeBundleBroadcastGuard = ({
  expectedAccount,
  expectedChainId,
  expectedConnectorKey,
  currentAccount,
  currentChainId,
  isSafeWallet,
  connectorContextKey,
}: {
  expectedAccount: Address
  expectedChainId: number
  expectedConnectorKey: string | undefined
  currentAccount: () => Address | undefined
  currentChainId: () => number | undefined
  isSafeWallet: () => boolean
  connectorContextKey: () => string | undefined
}): (() => void) => {
  return () => {
    assertWalletExecutionContext({
      expectedAccount,
      expectedChainId,
      currentAccount: currentAccount(),
      currentChainId: currentChainId(),
    })
    if (!isSafeWallet() || !expectedConnectorKey || connectorContextKey() !== expectedConnectorKey) {
      throw new Error('Wallet changed since review — please review the migration again.')
    }
  }
}
