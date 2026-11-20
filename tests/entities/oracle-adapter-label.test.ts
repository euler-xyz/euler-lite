import { describe, expect, it } from 'vitest'
import { getAddress, maxUint256 } from 'viem'
import {
  formatOracleAdapterLabel,
  formatUnboundedStaleness,
  getOracleCheckEvidenceLines,
  OracleAdapterCheckOutcome,
} from '~/entities/oracle'

// /v3/oracles/adapter-assessments/0x94a31084a0e8dbed217ee8763a20ab03e18b38f5?chainId=1 on 2026-11-20.
const PT_SBOLD = getAddress('0x1ff893c9071d04f8a965a90fcb0de22406a3eeaa')
const BOLD = getAddress('0x6440f144b7e50d6a8439336510312d2f54beb01d')
const adapter = { base: PT_SBOLD, quote: BOLD, label: 'Unknown AggregatorV3 Feed', name: 'ChainlinkInfrequentOracle' }
const symbols: Record<string, string> = { [PT_SBOLD.toLowerCase()]: 'PT-sBOLD-1765325646', [BOLD.toLowerCase()]: 'BOLD' }
const symbolOf = (address: string) => symbols[address.toLowerCase()]

describe('oracle adapter label', () => {
  it('names the adapter by the pair it prices, with V3\'s label after it', () => {
    expect(formatOracleAdapterLabel(adapter, symbolOf)).toBe('PT-sBOLD-1765325646 → BOLD price feed · Unknown AggregatorV3 Feed')
  })

  it('falls back to V3\'s label, then the adapter class, when the pair cannot be named', () => {
    expect(formatOracleAdapterLabel({ ...adapter, base: undefined }, symbolOf)).toBe('Unknown AggregatorV3 Feed')
    expect(formatOracleAdapterLabel(adapter, () => undefined)).toBe('Unknown AggregatorV3 Feed')
    expect(formatOracleAdapterLabel({ ...adapter, label: undefined, base: undefined }, symbolOf)).toBe('ChainlinkInfrequentOracle')
    expect(formatOracleAdapterLabel(undefined, symbolOf)).toBeUndefined()
  })

  it('ignores a base or quote that is not an address', () => {
    expect(formatOracleAdapterLabel({ ...adapter, base: 'not-an-address' }, () => 'X')).toBe('Unknown AggregatorV3 Feed')
  })

  it('names the pair alone when V3 gives no label or class', () => {
    expect(formatOracleAdapterLabel({ base: PT_SBOLD, quote: BOLD }, symbolOf)).toBe('PT-sBOLD-1765325646 → BOLD price feed')
  })
})

describe('unbounded maximum staleness', () => {
  const v3Text = `Adapter's maximum staleness (${maxUint256} s) must not exceed 604800 s.`

  it('reads a staleness above a hundred years as unbounded and leaves V3\'s other words alone', () => {
    expect(formatUnboundedStaleness(v3Text)).toBe('Adapter\'s maximum staleness (unbounded) must not exceed 604800 s.')
    expect(formatUnboundedStaleness('Adapter\'s maximum staleness (31536000 s) must not exceed 604800 s.'))
      .toBe('Adapter\'s maximum staleness (31536000 s) must not exceed 604800 s.')
  })

  it('reads an unbounded observed staleness as unbounded in the adapter\'s evidence', () => {
    const lines = getOracleCheckEvidenceLines({
      id: 'push-staleness-upper-bound',
      message: v3Text,
      outcome: OracleAdapterCheckOutcome.Fail,
      observed: maxUint256.toString(),
      expected: { maxSeconds: '604800' },
    } as Parameters<typeof getOracleCheckEvidenceLines>[0])
    expect(lines.find(line => line.key === 'observed')?.text).toBe('Observed: unbounded')
  })
})

describe('unbounded staleness in vault check findings', () => {
  it('reads an adapter-checks finding that quotes a max-uint staleness as unbounded', async () => {
    const { getVaultCheckMessage, getVaultCheckWarningLines } = await import('~/utils/vault-assessment/presentation')
    const summary = `An adapter has failing checks: adapter's maximum staleness (${maxUint256} s) must not exceed 604800 s.`
    const finding = { key: 'oracle.liability-quote', outcome: 'fail', required: false, description: 'Rule', cause: { code: 'x', subject: null, summary, remedy: null } }
    const expected = 'An adapter has failing checks: adapter\'s maximum staleness (unbounded) must not exceed 604800 s.'
    expect(getVaultCheckMessage(finding as never)).toBe(expected)
    const assessment = { configContext: { outcome: 'fail', findings: [finding] }, consistencyContext: null }
    expect(getVaultCheckWarningLines(assessment as never)[0]?.text).toBe(expected)
  })
})
