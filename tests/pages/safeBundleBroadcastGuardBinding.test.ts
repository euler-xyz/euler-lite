import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The direct Safe-bundle flows have no component harness, so this pins the
// call-site binding as source text: the broadcast guard's expected connector
// key must come from the reviewed preview (captured when the preview was
// built), never from a snapshot taken inside the confirmation flow — a
// confirmation-time snapshot runs after awaits the wallet can change under,
// so a connector swapped during those awaits would become the guard's
// accepted baseline.
const FLOWS = [
  {
    direction: 'outgoing',
    path: 'pages/position/[number]/migrate.vue',
  },
  {
    direction: 'inbound',
    path: 'pages/position/[number]/borrow/swap.vue',
  },
] as const

describe('direct Safe-bundle broadcast guard binding', () => {
  it.each(FLOWS)('$direction: the preview captures the connector key at build time', ({ path }) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    expect(source).toContain('connectorContextKey: walletConnectorContextKey(),')
  })

  it.each(FLOWS)('$direction: the guard validates against the reviewed preview key', ({ path }) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8')
    expect(source).toContain('expectedConnectorKey: preview.connectorContextKey,')
    // The live-state reader stays a thunk for the broadcast-time comparison;
    // an invoked form here would reintroduce the confirmation-time snapshot.
    expect(source).not.toContain('expectedConnectorKey: walletConnectorContextKey()')
  })
})
