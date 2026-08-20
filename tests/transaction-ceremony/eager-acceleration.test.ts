import { getAddress } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EVCBatchItem, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import { toCanonicalValue } from '~/features/transaction-ceremony/domain/canonical'
import {
  bindEagerPlanIntents,
  clearEagerAccelerationsForTests,
  matchEagerAcceleration,
  matchEagerMigrationCompilation,
  publishEagerMigrationCompilation,
  publishEagerPluginPrefetch,
  publishEagerPreparedPlan,
  publishEagerPreparedSimulation,
} from '~/features/transaction-ceremony/planning/eager-plan-intents'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const OTHER = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const TOKEN = getAddress('0x4000000000000000000000000000000000000000')
const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'eager-intent',
  revision: 1,
  kind: 'deposit',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 1n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 1n }],
  metadata: { source: 'test', createdAt: 1 },
}
const rawPlan = (): TransactionPlan => [{
  type: 'evcBatch',
  items: [{ targetContract: VAULT, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x12345678' }],
}]
const preparedPlan = (plan: TransactionPlan): TransactionPlanPrepared => ({
  __prepared: true,
  plan,
  chainId: 1,
  account: ACCOUNT,
  usePermit2: true,
  unlimitedApproval: false,
})

describe('form-time eager acceleration bridge', () => {
  beforeEach(clearEagerAccelerationsForTests)

  it('adopts only canonical plugin and simulation values after exact authoritative identity matches', () => {
    const raw = bindEagerPlanIntents(rawPlan(), [intent])
    const prepared = preparedPlan(rawPlan())
    const plugin = toCanonicalValue({ pyth: { entries: [] }, keyring: { gatedVaults: [] } })
    const projection = toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] })
    publishEagerPluginPrefetch(raw, plugin)
    publishEagerPreparedPlan(raw, prepared)
    publishEagerPreparedSimulation(prepared, projection)

    expect(matchEagerAcceleration({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: rawPlan(), owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: true,
    })).toEqual({ pluginPrefetch: plugin, simulationProjection: projection })
  })

  it.each([
    { name: 'owner', owner: OTHER, chainId: 1, usePermit2: true, unlimitedApproval: false },
    { name: 'chain', owner: ACCOUNT, chainId: 2, usePermit2: true, unlimitedApproval: false },
    { name: 'approval mode', owner: ACCOUNT, chainId: 1, usePermit2: false, unlimitedApproval: false },
    { name: 'approval amount mode', owner: ACCOUNT, chainId: 1, usePermit2: true, unlimitedApproval: true },
  ])('rejects simulation reuse after a $name identity change', ({ owner, chainId, usePermit2, unlimitedApproval }) => {
    const raw = bindEagerPlanIntents(rawPlan(), [intent])
    const prepared = preparedPlan(rawPlan())
    publishEagerPreparedPlan(raw, prepared)
    publishEagerPreparedSimulation(prepared, toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] }))

    expect(matchEagerAcceleration({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: rawPlan(), owner, chainId,
      usePermit2, unlimitedApproval, allowSimulation: true,
    }).simulationProjection).toBeUndefined()
  })

  it('rejects a page result when authoritative compilation produces different calldata', () => {
    const raw = bindEagerPlanIntents(rawPlan(), [intent])
    publishEagerPluginPrefetch(raw, toCanonicalValue({ pyth: { entries: [] } }))
    const changed = rawPlan()
    const item = changed[0]
    if (item?.type === 'evcBatch') (item.items[0] as EVCBatchItem).data = '0x87654321'

    expect(matchEagerAcceleration({
      intents: [intent], rawPlan: changed, owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: false,
    })).toEqual({})
  })

  it('never treats the mutable prepared object as cached authority', () => {
    const raw = bindEagerPlanIntents(rawPlan(), [intent])
    const prepared = preparedPlan(rawPlan())
    publishEagerPreparedPlan(raw, prepared)
    publishEagerPreparedSimulation(prepared, toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] }))
    const preparedItem = prepared.plan[0]
    if (preparedItem?.type === 'evcBatch') (preparedItem.items[0] as EVCBatchItem).data = '0x87654321'

    expect(matchEagerAcceleration({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: prepared.plan, owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: true,
    }).simulationProjection).toBeUndefined()
  })

  it('adopts a canonical migration compilation only at the exact observed block', () => {
    const migrationIntent: OperationIntent = {
      ...intent,
      intentId: 'migration-intent',
      kind: 'migration',
      planner: {
        name: 'cross-protocol-migration',
        args: {
          direction: 'external-to-euler', connectorId: 'aave', owner: ACCOUNT,
          positionRef: 'position-1', deadline: 2_000_000_000n, authorizationEvidenceDigest: `0x${'11'.repeat(32)}`,
        },
      },
      constraints: [{ kind: 'deadline', timestamp: 2_000_000_000 }],
    }
    const mutable = { plan: rawPlan(), previewPlan: rawPlan(), stateOverrides: [] }
    publishEagerMigrationCompilation(migrationIntent, mutable, 100n, 1_000)
    const adopted = matchEagerMigrationCompilation(migrationIntent, 100n, 1_001)

    expect(adopted).toEqual(mutable)
    expect(Object.isFrozen(adopted)).toBe(true)
    expect(matchEagerMigrationCompilation(migrationIntent, 101n, 1_001)).toBeUndefined()
    ;(mutable.previewPlan[0] as { type: string }).type = 'contractCall'
    expect(matchEagerMigrationCompilation(migrationIntent, 100n, 1_001)?.previewPlan[0]?.type).toBe('evcBatch')
    expect(matchEagerMigrationCompilation(migrationIntent, 100n, 61_000)).toBeUndefined()
  })
})
