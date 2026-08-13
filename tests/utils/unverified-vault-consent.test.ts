import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { buildUnverifiedVaultConsentKey, collectUnverifiedVaultConsentTargets } from '~/utils/unverified-vault-consent'

const owner = '0x0000000000000000000000000000000000000001' as Address
const verifiedVault = '0x0000000000000000000000000000000000000002' as Address
const unverifiedVault = '0x0000000000000000000000000000000000000003' as Address

const planFor = (...targets: Address[]): TransactionPlan => [{
  type: 'evcBatch',
  items: targets.map(targetContract => ({
    targetContract,
    onBehalfOfAccount: owner,
    value: 0n,
    data: '0x',
  })),
}] as TransactionPlan

describe('unverified vault consent', () => {
  it('builds consent from the exact unverified targets in a prepared plan', () => {
    const getVault = (address: string) => ({ shares: { name: address === unverifiedVault ? 'Unknown vault' : 'Known vault' } })
    const targets = collectUnverifiedVaultConsentTargets(
      [planFor(verifiedVault, unverifiedVault)],
      getVault,
      address => address.toLowerCase() === verifiedVault.toLowerCase(),
    )

    expect(targets).toEqual([{
      address: unverifiedVault.toLowerCase(),
      name: 'Unknown vault',
    }])
    expect(buildUnverifiedVaultConsentKey(1, owner, targets)).not.toBe(
      buildUnverifiedVaultConsentKey(1, owner, []),
    )
  })
})
