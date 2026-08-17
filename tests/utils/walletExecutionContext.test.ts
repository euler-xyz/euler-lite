import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { assertWalletExecutionContext, createSafeBundleBroadcastGuard } from '~/utils/walletExecutionContext'
import type { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OTHER_OWNER = '0x2222222222222222222222222222222222222222' as Address

describe('assertWalletExecutionContext', () => {
  it('accepts the captured account and chain', () => {
    expect(() => assertWalletExecutionContext({
      expectedAccount: OWNER,
      expectedChainId: 1,
      currentAccount: OWNER,
      currentChainId: 1,
    })).not.toThrow()
  })

  it('rejects account drift before broadcasting', () => {
    expect(() => assertWalletExecutionContext({
      expectedAccount: OWNER,
      expectedChainId: 1,
      currentAccount: OTHER_OWNER,
      currentChainId: 1,
    })).toThrow(expect.objectContaining<Partial<WalletExecutionContextChangedError>>({
      name: 'WalletExecutionContextChangedError',
      kind: 'account',
    }))
  })

  it('rejects chain drift before broadcasting', () => {
    expect(() => assertWalletExecutionContext({
      expectedAccount: OWNER,
      expectedChainId: 1,
      currentAccount: OWNER,
      currentChainId: 8453,
    })).toThrow(expect.objectContaining<Partial<WalletExecutionContextChangedError>>({
      name: 'WalletExecutionContextChangedError',
      kind: 'chain',
    }))
  })
})

describe('createSafeBundleBroadcastGuard', () => {
  // Mutable wallet state standing in for the reactive refs the pages read;
  // the guard is created at confirmation and invoked after the flow's
  // authorization/planning/preparation/simulation awaits.
  const walletState = () => ({
    account: OWNER as Address | undefined,
    chainId: 1 as number | undefined,
    safeWallet: true,
    connectorKey: 'safe:uid-1' as string | undefined,
  })

  const guardFor = (state: ReturnType<typeof walletState>) => createSafeBundleBroadcastGuard({
    expectedAccount: OWNER,
    expectedChainId: 1,
    currentAccount: () => state.account,
    currentChainId: () => state.chainId,
    isSafeWallet: () => state.safeWallet,
    connectorContextKey: () => state.connectorKey,
  })

  it('passes when the reviewed context is intact at the broadcast boundary', () => {
    const state = walletState()
    const guard = guardFor(state)
    expect(() => guard()).not.toThrow()
  })

  it('rejects a same-account connector switch during delayed preparation', () => {
    const state = walletState()
    const guard = guardFor(state)
    // Same owner, same chain, still classified as a Safe — only the connector
    // submitting the proposal changed while preparation was in flight.
    state.connectorKey = 'safe:uid-2'
    expect(() => guard()).toThrow('Wallet changed since review — please review the migration again.')
  })

  it('rejects a wallet that lost its Safe classification during the awaits', () => {
    const state = walletState()
    const guard = guardFor(state)
    state.safeWallet = false
    expect(() => guard()).toThrow('Wallet changed since review — please review the migration again.')
  })

  it('rejects a disconnected connector during delayed preparation', () => {
    const state = walletState()
    const guard = guardFor(state)
    state.connectorKey = undefined
    expect(() => guard()).toThrow('Wallet changed since review — please review the migration again.')
  })

  it('still rejects account and chain drift through the wallet context assertion', () => {
    const accountState = walletState()
    const accountGuard = guardFor(accountState)
    accountState.account = OTHER_OWNER
    expect(() => accountGuard()).toThrow(expect.objectContaining<Partial<WalletExecutionContextChangedError>>({
      name: 'WalletExecutionContextChangedError',
      kind: 'account',
    }))

    const chainState = walletState()
    const chainGuard = guardFor(chainState)
    chainState.chainId = 8453
    expect(() => chainGuard()).toThrow(expect.objectContaining<Partial<WalletExecutionContextChangedError>>({
      name: 'WalletExecutionContextChangedError',
      kind: 'chain',
    }))
  })
})
