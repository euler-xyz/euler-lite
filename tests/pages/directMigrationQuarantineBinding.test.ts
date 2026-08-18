import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The direct migration flows have no component harness, so this pins the
// quarantine wiring as source text: both directions must reconcile any
// previously accepted submission on-chain before sending, classify every
// broadcast through the quarantine's ordered tracker (standard and Safe-bundle
// paths alike), and durably retain an accepted-but-unconfirmed submission when
// the attempt fails. The quarantine behavior itself is covered by
// tests/utils/directSubmissionQuarantine.test.ts — this guards the call sites.
const FLOWS = [
  {
    direction: 'outgoing',
    path: 'pages/position/[number]/migrate.vue',
    flow: 'outgoing-migration',
    quarantine: 'migrationQuarantine',
    reconcile: 'reconcileMigrationQuarantine(preview)',
  },
  {
    direction: 'inbound',
    path: 'pages/position/[number]/borrow/swap.vue',
    flow: 'inbound-migration',
    quarantine: 'inboundMigrationQuarantine',
    reconcile: 'reconcileInboundMigrationQuarantine(preview)',
  },
] as const

const sourceOf = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('direct migration submission quarantine binding', () => {
  it.each(FLOWS)('$direction: creates a flow-scoped durable quarantine', ({ path, flow, quarantine }) => {
    const source = sourceOf(path)
    expect(source).toContain(`const ${quarantine} = createDirectSubmissionQuarantine({`)
    expect(source).toContain(`flow: '${flow}',`)
  })

  it.each(FLOWS)('$direction: reconciles the quarantine before any wallet action', ({ path, reconcile }) => {
    const source = sourceOf(path)
    // The gate sits right after the pending-signature restore, before the
    // deadline check, authorization work, and every broadcast.
    expect(source).toContain('if (!await restorePendingBeforeRetry()) return\n'
      + `    if (!await ${reconcile}) return`)
  })

  it.each(FLOWS)('$direction: arms attempt tracking before the wallet ceremony', ({ path, quarantine }) => {
    const source = sourceOf(path)
    expect(source).toContain(`${quarantine}.begin({ owner:`)
  })

  it.each(FLOWS)('$direction: tracks broadcasts on both execution paths', ({ path, quarantine }) => {
    const source = sourceOf(path)
    // Standard sequential path AND the Safe-bundle path: both value-moving
    // submissions must flow through the same ordered tracker.
    const trackBindings = source.split(`onBroadcast: ${quarantine}.track`).length - 1
    expect(trackBindings).toBe(2)
  })

  it.each(FLOWS)('$direction: seals an ambiguous submission when the attempt fails', ({ path, quarantine }) => {
    const source = sourceOf(path)
    expect(source).toContain(`const quarantined = ${quarantine}.sealFailure()`)
    expect(source).toContain('The submission may still confirm — retrying first verifies it on-chain before anything is re-sent.')
  })
})
