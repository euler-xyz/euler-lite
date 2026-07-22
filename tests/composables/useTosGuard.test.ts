import { describe, expect, it } from 'vitest'
import { isTosAcceptanceRequired } from '~/composables/guards/useTosGuard'

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
