import { beforeEach, describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  clearUnverifiedVaultAcknowledgements,
  hasUnverifiedVaultAcknowledgement,
  recordUnverifiedVaultAcknowledgement,
  unverifiedVaultAcknowledgementKey,
} from '~/features/reviewed-execution/policy/acknowledgements'

const ACCOUNT = getAddress('0x00000000000000000000000000000000000000a1')
const OTHER_ACCOUNT = getAddress('0x00000000000000000000000000000000000000a2')
const VAULT = getAddress('0x00000000000000000000000000000000000000b1')
const OTHER_VAULT = getAddress('0x00000000000000000000000000000000000000b2')

describe('unverified vault acknowledgements', () => {
  beforeEach(clearUnverifiedVaultAcknowledgements)

  it('normalizes and sorts the exact UI operation context', () => {
    const first = unverifiedVaultAcknowledgementKey({
      chainId: 1,
      account: ACCOUNT.toLowerCase(),
      operation: 'position-number-supply',
      vaults: [OTHER_VAULT, VAULT, VAULT],
    })
    const second = unverifiedVaultAcknowledgementKey({
      chainId: 1,
      account: ACCOUNT,
      operation: 'position-number-supply',
      vaults: [VAULT, OTHER_VAULT],
    })

    expect(first).toBe(second)
  })

  it('does not let final-plan consent cross account or chain boundaries', () => {
    recordUnverifiedVaultAcknowledgement({
      chainId: 1,
      account: ACCOUNT,
      operation: 'lend-vault',
      vaults: [VAULT],
    })

    expect(hasUnverifiedVaultAcknowledgement(VAULT, { chainId: 1, account: ACCOUNT })).toBe(true)
    expect(hasUnverifiedVaultAcknowledgement(VAULT, { chainId: 8453, account: ACCOUNT })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement(VAULT, { chainId: 1, account: OTHER_ACCOUNT })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement(OTHER_VAULT, { chainId: 1, account: ACCOUNT })).toBe(false)
  })
})
