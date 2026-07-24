import { describe, expect, it } from 'vitest'
import {
  getTosSessionAcceptanceKey,
  getTosBlockReason,
  hasTosSessionAcceptance,
  isTosAcceptanceRequired,
  TOS_ACCEPTANCE_PENDING_REASON,
  TOS_ACCEPTANCE_REQUIRED_REASON,
  TOS_LOAD_FAILED_REASON,
  withTosSessionAcceptance,
} from '~/composables/guards/useTosGuard'

const unsignedAccount = {
  hasWalletAddress: true,
  enableTosSignature: true,
  hasSigned: false,
  sessionAccepted: false,
  tosLoadFailed: false,
}

describe('isTosAcceptanceRequired', () => {
  it('does not require acceptance before a wallet is connected', () => {
    expect(isTosAcceptanceRequired({
      ...unsignedAccount,
      hasWalletAddress: false,
    })).toBe(false)
  })

  it('requires acceptance for a connected unsigned account', () => {
    expect(isTosAcceptanceRequired(unsignedAccount)).toBe(true)
  })

  it('does not prompt while the connected account signature check is pending', () => {
    expect(isTosAcceptanceRequired({
      ...unsignedAccount,
      hasSigned: null,
    })).toBe(false)
  })

  it('does not require acceptance again after the session accepts it', () => {
    expect(isTosAcceptanceRequired({
      ...unsignedAccount,
      sessionAccepted: true,
    })).toBe(false)
  })

  it('leaves load failures to the fail-closed blocker', () => {
    expect(isTosAcceptanceRequired({
      ...unsignedAccount,
      tosLoadFailed: true,
    })).toBe(false)
  })
})

describe('TOS session acceptance scoping', () => {
  const accountA = '0x1000000000000000000000000000000000000000'
  const accountB = '0x2000000000000000000000000000000000000000'

  it('scopes session acceptance to the accepting chain and account', () => {
    const accepted = withTosSessionAcceptance(
      {},
      getTosSessionAcceptanceKey({ chainId: 1, address: accountA }),
    )

    expect(hasTosSessionAcceptance(
      accepted,
      getTosSessionAcceptanceKey({ chainId: 1, address: accountA }),
    )).toBe(true)
    expect(hasTosSessionAcceptance(
      accepted,
      getTosSessionAcceptanceKey({ chainId: 1, address: accountB }),
    )).toBe(false)
    expect(hasTosSessionAcceptance(
      accepted,
      getTosSessionAcceptanceKey({ chainId: 8453, address: accountA }),
    )).toBe(false)
  })

  it('normalizes address casing before checking session acceptance', () => {
    const mixedCase = '0x8A54C278D117854486db0F6460D901a180Fff517'
    const lowerCase = mixedCase.toLowerCase()
    const accepted = withTosSessionAcceptance(
      {},
      getTosSessionAcceptanceKey({ chainId: 1, address: mixedCase }),
    )

    expect(hasTosSessionAcceptance(
      accepted,
      getTosSessionAcceptanceKey({ chainId: 1, address: lowerCase }),
    )).toBe(true)
  })
})

describe('getTosBlockReason', () => {
  it('does not block before a wallet is connected', () => {
    expect(getTosBlockReason({
      ...unsignedAccount,
      hasWalletAddress: false,
      hasSigned: null,
    })).toBeUndefined()
  })

  it('blocks without prompting while the signature check is pending', () => {
    expect(getTosBlockReason({
      ...unsignedAccount,
      hasSigned: null,
    })).toBe(TOS_ACCEPTANCE_PENDING_REASON)
  })

  it('blocks a connected unsigned account until terms are accepted', () => {
    expect(getTosBlockReason(unsignedAccount)).toBe(TOS_ACCEPTANCE_REQUIRED_REASON)
  })

  it('reacts to load failures even when the account was already signed', () => {
    expect(getTosBlockReason({
      ...unsignedAccount,
      hasSigned: true,
      tosLoadFailed: true,
    })).toBe(TOS_LOAD_FAILED_REASON)
  })

  it('unblocks a connected account that already signed', () => {
    expect(getTosBlockReason({
      ...unsignedAccount,
      hasSigned: true,
    })).toBeUndefined()
  })
})
