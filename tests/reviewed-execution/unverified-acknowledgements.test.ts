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

  it('requires the exact account, chain, operation, and vault set', () => {
    const acknowledgement = {
      chainId: 1,
      account: ACCOUNT,
      operation: 'lend-vault',
      vaults: [VAULT],
    }
    recordUnverifiedVaultAcknowledgement(acknowledgement)

    expect(hasUnverifiedVaultAcknowledgement(acknowledgement)).toBe(true)
    expect(hasUnverifiedVaultAcknowledgement({ ...acknowledgement, chainId: 8453 })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement({ ...acknowledgement, account: OTHER_ACCOUNT })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement({ ...acknowledgement, operation: 'position-number-supply' })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement({ ...acknowledgement, vaults: [VAULT, OTHER_VAULT] })).toBe(false)
    expect(hasUnverifiedVaultAcknowledgement({ ...acknowledgement, vaults: [] })).toBe(false)
  })

  it('does not compose acknowledgements for smaller vault sets', () => {
    const context = {
      chainId: 1,
      account: ACCOUNT,
      operation: 'lend-vault',
    }
    recordUnverifiedVaultAcknowledgement({ ...context, vaults: [VAULT] })
    recordUnverifiedVaultAcknowledgement({ ...context, vaults: [OTHER_VAULT] })

    expect(hasUnverifiedVaultAcknowledgement({ ...context, vaults: [VAULT, OTHER_VAULT] })).toBe(false)
  })
})
