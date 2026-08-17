import type { Address } from 'viem'
import { describe, expect, it } from 'vitest'
import { assertWalletExecutionContext, getWalletExecutionContextChange } from '~/utils/walletExecutionContext'
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

describe('getWalletExecutionContextChange', () => {
  it('treats an account disconnect as account drift', () => {
    expect(getWalletExecutionContextChange({
      expectedAccount: OWNER,
      expectedChainId: 1,
      currentAccount: undefined,
      currentChainId: 1,
    })).toBe('account')
  })

  it('accepts an unchanged disconnected context', () => {
    expect(getWalletExecutionContextChange({
      expectedAccount: undefined,
      expectedChainId: 1,
      currentAccount: undefined,
      currentChainId: 1,
    })).toBeUndefined()
  })
})
