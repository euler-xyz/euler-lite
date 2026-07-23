import { describe, expect, it } from 'vitest'
import {
  getTosBlockReason,
  isTosAcceptanceRequired,
  TOS_ACCEPTANCE_PENDING_REASON,
  TOS_ACCEPTANCE_REQUIRED_REASON,
  TOS_LOAD_FAILED_REASON,
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
