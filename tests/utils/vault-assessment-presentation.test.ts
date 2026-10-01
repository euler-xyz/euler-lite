import { describe, expect, it } from 'vitest'
import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import {
  getCriticalAssessmentWarning,
  getKnownUnlistedActionNotice,
  getNotListedLine,
  getUpcomingVaultChanges,
  getVaultCheckFindings,
  getVaultChecksStatusLine,
} from '~/utils/vault-assessment/presentation'

const finding = (key: string, overrides: Partial<VaultAssessmentFinding> = {}): VaultAssessmentFinding => ({
  key,
  outcome: 'fail',
  required: false,
  description: 'Description fallback',
  cause: { code: 'issue', subject: 'vault', summary: `V3 says ${key}`, remedy: null },
  ...overrides,
})
const assessment = (findings: VaultAssessmentFinding[], overrides: Partial<VaultAssessment> = {}): VaultAssessment => ({
  chainId: 1,
  vaultAddress: '0x0000000000000000000000000000000000000001',
  family: 'evk',
  configStatus: 'verified',
  checksStatus: 'positive',
  configReason: null,
  consistencyReason: null,
  configContext: { findings },
  consistencyContext: null,
  configLastCheckedAt: '2026-09-29T12:00:00.000Z',
  nextCheckAt: null,
  createdAt: '2026-09-28T12:00:00.000Z',
  assessed: true,
  ...overrides,
})

describe('vault checks presentation', () => {
  it('shows the selected failure classes with V3 sentences and counts other gating rules', () => {
    const view = getVaultCheckFindings(assessment([
      finding('oracle.liability-quote'),
      finding('collateral.0x01.ltv'),
      finding('collateral.0x02.ltv'),
      finding('deployment.factory'),
      finding('configuration.asset'),
      finding('oracle.adapters-recognized'),
      finding('evidence.safe-threshold'),
      finding('irm.max-apy', { outcome: 'pass' }),
      finding('market.asset-present', { outcome: 'not_applicable' }),
    ]))
    expect(view.lines.map(line => line.text)).toEqual([
      'V3 says oracle.liability-quote',
      'V3 says collateral.0x01.ltv',
    ])
    expect(view.moreCount).toBe(2)
    expect(view.reviewCount).toBe(4)
  })

  it.each([
    'hooks.zero-or-trusted', 'irm.max-apy', 'liquidation.max-discount',
    'governance.timelock', 'strategy.0x01.recognized', 'strategy.0x01.visible',
    'collateral.0x01.visible', 'governance.owner-registered', 'governance.curator-registered',
  ])('shows selected rule %s', (key) => {
    const overrides = key === 'hooks.zero-or-trusted'
      ? { cause: { code: 'exit-operations-disabled', subject: 'vault', summary: 'Exits disabled', remedy: null } }
      : {}
    expect(getVaultCheckFindings(assessment([finding(key, overrides)])).lines).toHaveLength(1)
  })

  it('keeps required unknowns undecided and filters ordinary passes', () => {
    const undecided = assessment([
      finding('oracle.liability-quote', { outcome: 'unknown', required: true }),
      finding('liquidation.max-discount', { outcome: 'unknown' }),
    ])
    const view = getVaultCheckFindings(undecided)
    expect(view.lines).toMatchObject([{ outcome: 'unknown', text: 'Being re-checked' }])
    expect(getVaultChecksStatusLine(undecided, 'available')).toBe('Being re-checked')
  })

  it('prefers a confirmed collateral failure over an earlier unknown for the same rule', () => {
    const mixed = assessment([
      finding('collateral.0x01.ltv', { outcome: 'unknown', required: true }),
      finding('collateral.0x02.ltv'),
    ])
    expect(getVaultCheckFindings(mixed).lines).toEqual([{
      key: 'collateral.*.ltv',
      text: 'V3 says collateral.0x02.ltv',
      outcome: 'fail',
    }])
    expect(getVaultChecksStatusLine(mixed, 'available')).toBe('Flagged · 1 to review')
  })

  it('distinguishes passing, flagged, missing and unavailable states', () => {
    const now = Date.parse('2026-09-29T12:12:00.000Z')
    expect(getVaultChecksStatusLine(assessment([]), 'available', now)).toBe('Verified · checked 12 min ago')
    expect(getVaultChecksStatusLine(assessment([finding('oracle.liability-quote')]), 'available', now)).toBe('Flagged · 1 to review')
    expect(getVaultChecksStatusLine(undefined, 'available', now)).toBe('Not assessed yet')
    expect(getVaultChecksStatusLine(undefined, 'unavailable', now)).toBe('Checks unavailable')
    expect(getVaultChecksStatusLine(undefined, 'loading', now)).toBe('')
  })

  it('renders producer-shaped scheduled Earn changes with pending values and failed future checks', () => {
    const result = getUpcomingVaultChanges(assessment([
      finding('scheduled.strategy.0x01.recognized', {
        observed: { validAt: '2026-10-01T00:00:00.000Z', pending: { strategy: '0x01', cap: '20000000', verdict: 'fail' } },
        cause: { code: 'pending', subject: 'strategy', summary: 'Pending change, acceptable from Oct 1: strategy cap is high', remedy: null },
      }),
      finding('scheduled.governance.timelock', {
        outcome: 'pass',
        observed: { validAt: '2026-10-02T00:00:00.000Z', pending: '86400' },
        cause: { code: 'pending', subject: 'vault', summary: 'Pending timelock will pass', remedy: null },
      }),
      finding('scheduled.governance.owner-registered', {
        observed: { validAt: null, pending: { owner: '0x00000000000000000000000000000000000000aa', entityId: null } },
        cause: { code: 'pending', subject: 'vault', summary: 'Pending owner is unregistered', remedy: null },
      }),
    ], { family: 'earn' }), { decimals: 6, symbol: 'USDC' })
    expect(result).toEqual([
      { key: 'scheduled.strategy.0x01.recognized', text: 'from Oct 1, 2026 · cap 20 USDC · strategy cap is high · would not pass the checks', failing: true },
      { key: 'scheduled.governance.timelock', text: 'from Oct 2, 2026 · timelock 1 day · Pending timelock will pass', failing: false },
      { key: 'scheduled.governance.owner-registered', text: 'owner 0x00000000000000000000000000000000000000aa · Pending owner is unregistered · would not pass the checks', failing: true },
    ])
  })

  it('only makes a form warning for exit and pricing failures', () => {
    expect(getCriticalAssessmentWarning(assessment([finding('oracle.adapters-recognized')]))).toBeNull()
    expect(getCriticalAssessmentWarning(assessment([finding('hooks.zero-or-trusted', {
      cause: { code: 'exit-operations-disabled', subject: 'vault', summary: 'Exits disabled', remedy: null },
    })]))?.message).toBe('Exits disabled')
  })

  it('uses distinct non-phishing copy for hidden and pending review', () => {
    expect(getNotListedLine('hidden', 'The check failed')).toBe('This vault is not listed: The check failed.')
    expect(getNotListedLine('pending_review')).toBe('This vault has not been checked yet, so it is not listed.')
    const address = '0x0000000000000000000000000000000000000001'
    const visibility = { [address]: { status: 'hidden', reason: 'The check failed' } }
    expect(getKnownUnlistedActionNotice([address], 'v3', visibility)).toBe('This vault is not listed: The check failed.')
    expect(getKnownUnlistedActionNotice([address], 'v3', { [address]: { status: 'pending_review' } })).toBe('This vault has not been checked yet, so it is not listed.')
    expect(getKnownUnlistedActionNotice([address], 'static', visibility)).toBeNull()
    expect(getKnownUnlistedActionNotice([address, '0x0000000000000000000000000000000000000002'], 'v3', visibility)).toBeNull()
  })
})
