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

export const WALLET_CHANGED_SINCE_REVIEW_ERROR
  = 'Wallet changed since review — please review the migration again.'

/**
 * Guard for the irreversible wallet-action boundaries (signature requests,
 * grant broadcasts, plan broadcasts) of a flow reviewed under one connector.
 *
 * Account and chain checks cannot see a same-account connector switch, and
 * confirmation awaits (pending restoration, authorization lookup, planning,
 * preparation, simulation) all yield before each wallet action. Snapshotting
 * the connector inside the confirmation flow would accept a connector swapped
 * during an earlier await as the baseline, so `expectedConnectorKey` must be
 * the key the reviewed preview captured when it was built. The returned
 * callback re-asserts the reviewed context — account, chain, and connector —
 * immediately before each wallet action, and fails closed when the review
 * captured no connector at all.
 */
export const createReviewedWalletContextGuard = ({
  expectedAccount,
  expectedChainId,
  expectedConnectorKey,
  currentAccount,
  currentChainId,
  connectorContextKey,
}: {
  expectedAccount: Address
  expectedChainId: number
  expectedConnectorKey: string | undefined
  currentAccount: () => Address | undefined
  currentChainId: () => number | undefined
  connectorContextKey: () => string | undefined
}): (() => void) => {
  return () => {
    assertWalletExecutionContext({
      expectedAccount,
      expectedChainId,
      currentAccount: currentAccount(),
      currentChainId: currentChainId(),
    })
    if (!expectedConnectorKey || connectorContextKey() !== expectedConnectorKey) {
      throw new Error(WALLET_CHANGED_SINCE_REVIEW_ERROR)
    }
  }
}

/**
 * Guard for the irreversible broadcast boundary of a direct Safe-bundle flow:
 * the reviewed wallet context (account, chain, connector) plus the Safe
 * classification the bundled review promised — a wallet that stopped
 * classifying as a Safe cannot submit the reviewed single-proposal ceremony.
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
  const assertReviewedContext = createReviewedWalletContextGuard({
    expectedAccount,
    expectedChainId,
    expectedConnectorKey,
    currentAccount,
    currentChainId,
    connectorContextKey,
  })
  return () => {
    assertReviewedContext()
    if (!isSafeWallet()) {
      throw new Error(WALLET_CHANGED_SINCE_REVIEW_ERROR)
    }
  }
}
