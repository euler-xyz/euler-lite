import { describe, expect, it } from 'vitest'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { depositTargetVaults } from '~/utils/vault-action-targets'

const SOURCE = '0x0000000000000000000000000000000000000011'
const TARGET = '0x0000000000000000000000000000000000000022'
const DEBT = '0x0000000000000000000000000000000000000033'
const ACCOUNT = '0x0000000000000000000000000000000000000044'

const intent = (name: OperationIntent['planner']['name'], args: Record<string, unknown>): OperationIntent =>
  ({ planner: { name, args } }) as OperationIntent

describe('vault action targets', () => {
  it('uses the swap receiver for a deposit even when a different vault is verified', () => {
    const value = intent('deposit-with-swap', {
      swapQuote: { receiver: TARGET, accountOut: ACCOUNT, verify: { vault: SOURCE } },
    })
    expect(depositTargetVaults(value)).toEqual([TARGET])
  })

  it('finds collateral deposit destinations in a refinance', () => {
    const value = intent('refinance-position', {
      collateral: { planner: 'migrate-same-asset-collateral', args: { fromVault: SOURCE, toVault: TARGET } },
      debt: { planner: 'migrate-same-asset-debt', args: { oldLiabilityVault: SOURCE, newLiabilityVault: DEBT } },
    })
    expect(depositTargetVaults(value)).toEqual([TARGET])
  })

  it('does not require a deposit acknowledgement for an outbound migration', () => {
    const value = intent('cross-protocol-migration', {
      direction: 'euler-to-external',
      source: { collateralVault: SOURCE, borrowVault: DEBT },
    })
    expect(depositTargetVaults(value)).toEqual([])
  })
})
