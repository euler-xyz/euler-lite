import { getAddress } from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EVCBatchItem, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import { toCanonicalValue } from '~/features/transaction-ceremony/domain/canonical'
import {
  clearPreviewEvidenceForTests,
  matchPreviewEvidence,
  matchPreviewMigrationCompilation,
  publishPreviewMigrationCompilation,
  publishPreviewPluginEvidence,
  publishPreviewPreparedEvidence,
  publishPreviewSimulationEvidence,
} from '~/features/transaction-ceremony/planning/preview-evidence'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const OTHER = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const TOKEN = getAddress('0x4000000000000000000000000000000000000000')
const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'preview-intent',
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

describe('form-time preview evidence', () => {
  beforeEach(clearPreviewEvidenceForTests)

  it('matches preview evidence by canonical content across distinct plan objects', () => {
    const raw = rawPlan()
    const equivalent = rawPlan()
    const plugin = toCanonicalValue({ pyth: { entries: [] } })

    expect(equivalent).not.toBe(raw)
    publishPreviewPluginEvidence([intent], raw, plugin)
    expect(matchPreviewEvidence({
      intents: [intent], rawPlan: equivalent, owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: false,
    })).toEqual({ pluginPrefetch: plugin })
  })

  it('adopts only canonical plugin and simulation values after exact authoritative identity matches', () => {
    const raw = rawPlan()
    const prepared = preparedPlan(rawPlan())
    const plugin = toCanonicalValue({ pyth: { entries: [] }, keyring: { gatedVaults: [] } })
    const projection = toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] })
    publishPreviewPluginEvidence([intent], raw, plugin)
    publishPreviewPreparedEvidence([intent], raw, prepared)
    publishPreviewSimulationEvidence([intent], preparedPlan(rawPlan()), projection)

    expect(matchPreviewEvidence({
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
    const raw = rawPlan()
    const prepared = preparedPlan(rawPlan())
    publishPreviewPreparedEvidence([intent], raw, prepared)
    publishPreviewSimulationEvidence([intent], prepared, toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] }))

    expect(matchPreviewEvidence({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: rawPlan(), owner, chainId,
      usePermit2, unlimitedApproval, allowSimulation: true,
    }).simulationProjection).toBeUndefined()
  })

  it('does not carry simulation evidence across prepared approval modes', () => {
    const raw = rawPlan()
    const permit2 = preparedPlan(rawPlan())
    const directApproval = { ...preparedPlan(rawPlan()), usePermit2: false }
    const projection = toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] })
    publishPreviewPreparedEvidence([intent], raw, permit2)
    publishPreviewSimulationEvidence([intent], permit2, projection)
    publishPreviewPreparedEvidence([intent], raw, directApproval)

    expect(matchPreviewEvidence({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: rawPlan(), owner: ACCOUNT, chainId: 1,
      usePermit2: false, unlimitedApproval: false, allowSimulation: true,
    }).simulationProjection).toBeUndefined()
  })

  it('rejects simulation publication from another prepared context', () => {
    const raw = rawPlan()
    const permit2 = preparedPlan(rawPlan())
    publishPreviewPreparedEvidence([intent], raw, permit2)
    publishPreviewSimulationEvidence(
      [intent],
      { ...preparedPlan(rawPlan()), usePermit2: false },
      toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] }),
    )

    expect(matchPreviewEvidence({
      intents: [intent], rawPlan: rawPlan(), preparedPlan: rawPlan(), owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: true,
    }).simulationProjection).toBeUndefined()
  })

  it('rejects a page result when authoritative compilation produces different calldata', () => {
    const raw = rawPlan()
    publishPreviewPluginEvidence([intent], raw, toCanonicalValue({ pyth: { entries: [] } }))
    const changed = rawPlan()
    const item = changed[0]
    if (item?.type === 'evcBatch') (item.items[0] as EVCBatchItem).data = '0x87654321'

    expect(matchPreviewEvidence({
      intents: [intent], rawPlan: changed, owner: ACCOUNT, chainId: 1,
      usePermit2: true, unlimitedApproval: false, allowSimulation: false,
    })).toEqual({})
  })

  it('never treats the mutable prepared object as cached authority', () => {
    const raw = rawPlan()
    const prepared = preparedPlan(rawPlan())
    publishPreviewPreparedEvidence([intent], raw, prepared)
    publishPreviewSimulationEvidence([intent], prepared, toCanonicalValue({ canExecute: true, simulatedAccounts: [], simulatedVaults: [] }))
    const preparedItem = prepared.plan[0]
    if (preparedItem?.type === 'evcBatch') (preparedItem.items[0] as EVCBatchItem).data = '0x87654321'

    expect(matchPreviewEvidence({
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
    publishPreviewMigrationCompilation(migrationIntent, mutable, 100n, 1_000)
    const adopted = matchPreviewMigrationCompilation(migrationIntent, 100n, 1_001)

    expect(adopted).toEqual(mutable)
    expect(Object.isFrozen(adopted)).toBe(true)
    expect(matchPreviewMigrationCompilation(migrationIntent, 101n, 1_001)).toBeUndefined()
    ;(mutable.previewPlan[0] as { type: string }).type = 'contractCall'
    expect(matchPreviewMigrationCompilation(migrationIntent, 100n, 1_001)?.previewPlan[0]?.type).toBe('evcBatch')
    expect(matchPreviewMigrationCompilation(migrationIntent, 100n, 61_000)).toBeUndefined()
  })
})
