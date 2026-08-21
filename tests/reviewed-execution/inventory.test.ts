import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BATCH_FORM_SOURCE_INVENTORY,
  BATCH_PERFORMANCE_REGISTRY,
  OPERATION_INVENTORY,
  REVIEW_SOURCE_INVENTORY,
  WALLET_WRITE_SOURCE_INVENTORY,
} from '~/features/reviewed-execution/inventory/registry'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0
const listProductionSources = (relativeDirectory: string): string[] => readdirSync(resolve(root, relativeDirectory), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory()
    ? listProductionSources(`${relativeDirectory}/${entry.name}`)
    : /\.(?:ts|vue)$/.test(entry.name) ? [`${relativeDirectory}/${entry.name}`] : [])

const productionSources = [
  ...new Set([
    ...BATCH_FORM_SOURCE_INVENTORY.map(row => row.source),
    ...REVIEW_SOURCE_INVENTORY.map(row => row.source),
    ...WALLET_WRITE_SOURCE_INVENTORY.map(row => row.source),
  ]),
]

describe('Stage A transaction inventory', () => {
  it('records every current batch-form add boundary', () => {
    const candidates = ['pages', 'components', 'composables'].flatMap(listProductionSources)
    const discovered = candidates
      .map(source => ({ source, expectedOccurrences: count(read(source), /\baddBatchEntry\s*\(/g) }))
      .filter(row => row.expectedOccurrences > 0)
      .sort((left, right) => left.source.localeCompare(right.source))
    const inventoried = [...BATCH_FORM_SOURCE_INVENTORY]
      .map(row => ({ ...row }))
      .sort((left, right) => left.source.localeCompare(right.source))

    expect(discovered).toEqual(inventoried)
    for (const row of BATCH_FORM_SOURCE_INVENTORY) {
      expect(count(read(row.source), /\baddBatchEntry\s*\(/g), row.source)
        .toBe(row.expectedOccurrences)
    }
  })

  it('owns one performance case for every batch-form branch', () => {
    expect(new Set(BATCH_PERFORMANCE_REGISTRY.map(row => row.id)).size)
      .toBe(BATCH_PERFORMANCE_REGISTRY.length)
    expect(BATCH_PERFORMANCE_REGISTRY.length)
      .toBe(BATCH_FORM_SOURCE_INVENTORY.reduce((sum, row) => sum + row.expectedOccurrences, 0))

    for (const row of BATCH_FORM_SOURCE_INVENTORY) {
      expect(BATCH_PERFORMANCE_REGISTRY.filter(testCase => testCase.source === row.source), row.source)
        .toHaveLength(row.expectedOccurrences)
    }
  })

  it('records every current operation and the deliberately absent surfaces', () => {
    expect(new Set(OPERATION_INVENTORY.map(row => row.id)).size).toBe(OPERATION_INVENTORY.length)
    expect(OPERATION_INVENTORY.filter(row => row.disposition === 'legacy-in-scope')).toEqual([])
    expect(OPERATION_INVENTORY.find(row => row.id === 'fee-flow-buy')?.disposition).toBe('absent')
    expect(OPERATION_INVENTORY.find(row => row.id === 'liquidation')?.disposition).toBe('absent')

    const production = productionSources.map(read).join('\n')
    expect(production).not.toMatch(/feeFlowService\s*\.\s*buildBuyPlan\s*\(/)
    expect(production).not.toMatch(/executionService\s*\.\s*planLiquidation\s*\(/)
  })

  it('freezes the current review launch inventory', () => {
    const candidates = ['pages', 'components', 'composables'].flatMap(listProductionSources)
    const pattern = /modal\.open\((?:OperationReviewModal|BatchReviewModal)|\bopen(?:Eager)?ReviewState\s*\(/g
    const discovered = candidates
      .map(source => ({ source, expectedOccurrences: count(read(source), pattern) }))
      .filter(row => row.expectedOccurrences > 0)
      .sort((left, right) => left.source.localeCompare(right.source))
    const inventoried = [...REVIEW_SOURCE_INVENTORY]
      .map(row => ({ ...row }))
      .sort((left, right) => left.source.localeCompare(right.source))
    expect(discovered).toEqual(inventoried)

    for (const row of REVIEW_SOURCE_INVENTORY) {
      const source = read(row.source)
      const actual = count(source, pattern)
      expect(actual, row.source).toBe(row.expectedOccurrences)
    }
  })

  it('keeps operation authority explicit and independent of SDK object identity', () => {
    const candidates = ['pages', 'components', 'composables', 'features/reviewed-execution']
      .flatMap(listProductionSources)
    const production = candidates.map(source => read(source)).join('\n')

    expect(production).not.toMatch(/\b(?:openEagerPlan|bindEagerPlanIntents|getEagerPlanIntents|collectEagerPlanIntents)\b/)
    expect(read('features/reviewed-execution/planning/preview-cache.ts')).not.toMatch(/\bWeakMap\b|\btoRaw\b/)
    expect(read('composables/useEulerTx.ts')).not.toMatch(/\bcreateOperationIntent\b/)
    expect(production).not.toMatch(/\bopenReviewState\s*\(\s*(?:plan|rawPlan|multiplyPlan)\b/)
    expect(count(read('composables/useReviewedExecution.ts'), /\buseConfig\(\)/g)).toBe(1)
  })

  it('keeps lifecycle authority centered on intents and reviewed executions', () => {
    const production = ['pages', 'components', 'composables', 'features/reviewed-execution']
      .flatMap(listProductionSources)
      .map(source => read(source))
      .join('\n')
    const domain = read('features/reviewed-execution/domain/reviewed-execution.ts')
      + read('features/reviewed-execution/domain/intents.ts')
      + read('features/reviewed-execution/coordinator/coordinator.ts')

    expect(production).not.toMatch(/\b(?:Ceremony|ceremony)\b/)
    expect(domain).toMatch(/interface OperationIntent\b/)
    expect(domain).toMatch(/interface ReviewedExecution\b/)
    expect(domain).toMatch(/interface SubmissionResult\b/)
    expect(production).not.toMatch(/IndexedDbSubmissionJournal|SubmissionRecoveryService|withWalletLaneLock|BroadcastChannel|ExecutionEmergencySwitch|MutableExecutionEmergencySwitch|emergencySwitch/)
  })

  it('starts cleanly after reload without removing current-session Safe detachment', () => {
    for (const path of [
      'features/reviewed-execution/persistence/journal.ts',
      'features/reviewed-execution/persistence/locks.ts',
      'features/reviewed-execution/coordinator/recovery.ts',
      'features/reviewed-execution/coordinator/reconcilers.ts',
      'features/reviewed-execution/coordinator/emergency-switch.ts',
      'composables/useReviewedExecutionRecovery.ts',
      'components/entities/reviewed-execution/ReviewedExecutionRecovery.vue',
    ]) expect(existsSync(resolve(root, path)), path).toBe(false)

    expect(read('app.vue')).not.toMatch(/ReviewedExecutionRecovery|useReviewedExecutionRecovery/)
    expect(read('composables/useReviewedExecution.ts')).not.toMatch(/indexedDB|localStorage|BroadcastChannel|\.resume\(|\.reconcile\(/i)
    expect(existsSync(resolve(root, 'composables/useSafeExecutionDetachment.ts'))).toBe(true)
  })

  it('renders migration and revocation outcomes as separate statuses', () => {
    const sources = [
      read('pages/position/[number]/migrate.vue'),
      read('pages/position/[number]/borrow/swap.vue'),
      read('components/BatchReviewModal.vue'),
    ].join('\n')

    expect(count(sources, /Migration submitted/g)).toBeGreaterThanOrEqual(3)
    expect(count(sources, /Authorization revocation status:/g)).toBeGreaterThanOrEqual(3)
  })

  it('forbids new wallet write owners outside the frozen in-scope and excluded boundaries', () => {
    const candidates = ['pages', 'components', 'composables', 'features', 'utils'].flatMap(listProductionSources)
    const writePattern = /\b(?:useSendTransaction|useSignTypedData|sendCalls|sendTransaction)\s*\(|eth_signTypedData_v4|\.execute(?:TransactionPlan|PreparedTransactionPlan|CowSwapTransactionPlan)\s*\(/
    const actualOwners = candidates.filter(path => writePattern.test(read(path)))

    expect(actualOwners.sort()).toEqual(WALLET_WRITE_SOURCE_INVENTORY.map(row => row.source).sort())
  })
})

describe('review compatibility fixtures', () => {
  const fixtures = [
    { path: 'components/entities/operation/OperationReviewModal.vue', templateOnly: true, sha256: 'a6b35defabe1c9610b482e63c9c5d9c77b1ffcbd2b78c5d67a4f96516c8a1f2d' },
    { path: 'components/BatchReviewModal.vue', templateOnly: true, sha256: '14a568abd87d8fe644749c84a5f63396276d098db123f2cffb9853c18d06d9cd' },
    { path: 'utils/stepDecoding.ts', templateOnly: false, sha256: '6b91c9d294290692982531800909cfbb9827125a916b85ce7febc8d0fd48e8e6' },
    { path: 'utils/batchReviewDisplay.ts', templateOnly: false, sha256: 'c8e892115e9bba21ad695b5cdd158e6b69d8aefc9ceb3c5aaae2faf17128ade4' },
  ] as const

  it.each(fixtures)('keeps $path presentation output source unchanged', ({ path, templateOnly, sha256 }) => {
    const source = read(path).replace(/\r\n/g, '\n')
    const presentation = templateOnly
      ? source.match(/<template>[\s\S]*<\/template>/)?.[0] ?? ''
      : source
    expect(createHash('sha256').update(presentation).digest('hex')).toBe(sha256)
  })

  it('keeps Pyth details out of both review templates', () => {
    const templates = [
      read('components/entities/operation/OperationReviewModal.vue'),
      read('components/BatchReviewModal.vue'),
    ].map(source => source.match(/<template>[\s\S]*<\/template>/)?.[0] ?? '').join('\n')

    expect(templates).not.toMatch(/pyth|feed\s*id|payload\s*hash|max(?:imum)?\s*fee|freshness/i)
  })
})
