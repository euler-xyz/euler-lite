import { describe, expect, it } from 'vitest'
import type { VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { groupVaultCheckRows } from '~/utils/vault-assessment/check-rows'

const PRIME = '0x797dd80692c3b2dadabce8e30c07fde5307d48a9'
const YIELD = '0xe0a80d35bb6618cba260120b279d357978c42bce'
const ALPHA = '0x6fe7fa90756434645f0b0428fdff78e99dda0fbc'

const finding = (key: string, outcome: VaultAssessmentFinding['outcome'] = 'pass'): VaultAssessmentFinding => ({
  key,
  outcome,
  required: true,
  description: key,
  cause: null,
})

const summarize = (rows: ReturnType<typeof groupVaultCheckRows>) =>
  rows.map(row => [row.key, row.findings.map(item => `${item.outcome}:${item.key.split('.').at(-1)}`)])

describe('groupVaultCheckRows', () => {
  const findings = [
    finding(`strategy.${ALPHA}.recognized`),
    finding(`strategy.${PRIME}.recognized`),
    finding(`strategy.${YIELD}.recognized`),
    finding(`strategy.${ALPHA}.visible`, 'fail'),
    finding(`strategy.${PRIME}.visible`),
    finding(`strategy.${YIELD}.visible`),
  ]
  const shares: Record<string, number> = { [PRIME]: 0.94, [ALPHA]: 0.06, [YIELD]: 0 }
  const weightOf = ({ address }: { address: string }) => shares[address.toLowerCase()] ?? null

  it('keeps each vault\'s checks together, a failing vault first, then by weight', () => {
    expect(summarize(groupVaultCheckRows(findings, weightOf))).toEqual([
      [`strategy.${ALPHA}`, ['fail:visible', 'pass:recognized']],
      [`strategy.${PRIME}`, ['pass:recognized', 'pass:visible']],
      [`strategy.${YIELD}`, ['pass:recognized', 'pass:visible']],
    ])
  })

  it('names the subject of a row', () => {
    expect(groupVaultCheckRows(findings)[0]?.subject).toEqual({ namespace: 'strategy', address: getAddress(ALPHA) })
  })

  it('puts a vault of unknown weight after the weighed ones, in the order the checks came', () => {
    const rows = groupVaultCheckRows(findings.filter(item => item.outcome === 'pass'), address => address.address.toLowerCase() === YIELD ? 0 : null)
    expect(rows.map(row => row.key)).toEqual([`strategy.${YIELD}`, `strategy.${ALPHA}`, `strategy.${PRIME}`])
  })

  it('reads a scheduled check of a strategy as that strategy\'s, and keeps a check without a subject on its own row', () => {
    const rows = groupVaultCheckRows([
      finding('scheduled.governance.timelock'),
      finding(`scheduled.strategy.${PRIME}.recognized`, 'fail'),
      finding('scheduled.governance.timelock'),
    ])
    expect(rows.map(row => [row.key, row.subject?.namespace ?? null])).toEqual([
      [`strategy.${PRIME}`, 'strategy'],
      ['scheduled.governance.timelock#0', null],
      ['scheduled.governance.timelock#2', null],
    ])
  })

  it('compares weights within one namespace only, a strategy\'s share never against a collateral\'s dollars', () => {
    const collateral = '0x00000000000000000000000000000000000000c1'
    const rows = groupVaultCheckRows(
      [finding(`scheduled.collateral.${collateral}.visible`), finding(`scheduled.strategy.${PRIME}.visible`)],
      ({ namespace }) => namespace === 'collateral' ? 500 : 0.94,
    )
    expect(rows.map(row => row.subject?.namespace)).toEqual(['strategy', 'collateral'])
  })
})
