import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import { assertExactWalletBinding, changedWalletBindingFields } from '~/features/reviewed-execution/coordinator/coordinator'
import type { WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'

const binding: WalletBinding = {
  chainId: 8453,
  account: getAddress('0x00000000000000000000000000000000000000a1'),
  subAccounts: [getAddress('0x00000000000000000000000000000000000000a1')],
  connectorId: 'injected',
  connectorSessionId: 'session-1',
  walletKind: 'eoa',
  classificationVersion: '1',
  approvalMode: 'permit2',
}

describe('wallet binding drift', () => {
  it('names the fields that changed since the review', () => {
    const flipped: WalletBinding = { ...binding, approvalMode: 'approve', connectorSessionId: 'session-2' }
    expect(changedWalletBindingFields(binding, flipped)).toEqual(['approvalMode', 'connectorSessionId'])
    expect(() => assertExactWalletBinding(binding, flipped)).toThrow('Wallet binding changed after review (approvalMode, connectorSessionId)')
  })

  it('accepts a binding that only differs in address casing', () => {
    const recased = { ...binding, account: binding.account.toLowerCase() as WalletBinding['account'] }
    expect(changedWalletBindingFields(binding, recased)).toEqual([])
    expect(() => assertExactWalletBinding(binding, recased)).not.toThrow()
  })
})
