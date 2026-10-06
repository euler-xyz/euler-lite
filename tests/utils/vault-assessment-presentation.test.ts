import { describe, expect, it } from 'vitest'
import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import {
  getVaultChecksCell,
  getVaultCheckFindingTone,
  getUnknownVaultCause,
  getVaultCheckWarningLines,
  getCriticalAssessmentWarning,
  getKnownUnlistedActionNotice,
  getUnverifiedActionCopy,
  getNotListedLine,
  getUpcomingVaultChanges,
  getVaultAssessmentCheckDetails,
  getVaultCheckFindings,
  getVaultChecksStatusLine,
  hasOnlyAcceptedVaultCheckFindings,
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
  configContext: { findings, outcome: 'pass' },
  consistencyContext: null,
  configLastCheckedAt: '2026-09-29T12:00:00.000Z',
  nextCheckAt: null,
  createdAt: '2026-09-28T12:00:00.000Z',
  assessed: true,
  ...overrides,
})

describe('vault checks presentation', () => {
  it('shows every finding while separating active failures from accepted exceptions', () => {
    const reviewed = assessment([
      finding('deployment.factory', { outcome: 'pass', required: true }),
      finding('irm.max-apy', { outcome: 'fail' }),
      finding('liquidation.max-discount', { outcome: 'fail', exempted: true }),
      finding('oracle.liability-quote', { outcome: 'unknown', required: true }),
      finding('scheduled.governance.timelock', { outcome: 'not_applicable' }),
    ])

    expect(getVaultAssessmentCheckDetails(reviewed).counts).toEqual({
      passed: 1, failed: 1, unknown: 1, accepted: 1, notApplicable: 1,
    })
    expect(getVaultAssessmentCheckDetails(reviewed).findings.map(item => item.key)).toEqual([
      'irm.max-apy', 'oracle.liability-quote', 'liquidation.max-discount',
      'deployment.factory', 'scheduled.governance.timelock',
    ])
  })

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
    expect(getVaultChecksStatusLine(mixed, 'available')).toBe('Warning · 1 to review')
  })

  it('reads a vault with only accepted exceptions as passed', () => {
    const flagged = assessment([
      finding('liquidation.max-discount', { exempted: true }),
      finding('collateral.0x01.ltv', { exempted: true }),
      finding('governance.timelock', { outcome: 'unknown', required: true, exempted: true }),
    ], { checksStatus: 'warning' })

    expect(getVaultCheckFindings(flagged).lines).toEqual([])
    expect(hasOnlyAcceptedVaultCheckFindings(flagged)).toBe(true)
    expect(getVaultChecksStatusLine(flagged, 'available', Date.parse('2026-09-29T12:12:00.000Z'))).toBe('Checks passed · checked 12 min ago')
    expect(hasOnlyAcceptedVaultCheckFindings(assessment([
      finding('liquidation.max-discount', { exempted: true }),
      finding('irm.max-apy'),
    ], { checksStatus: 'warning' }))).toBe(false)
  })

  it('makes a shortened finding address copyable only when it matches the full V3 address', () => {
    const address = '0xf037eeeba7729c39114b9711c75fbccca4a343c8'
    const summary = 'Collateral 0xf037ee…43c8 has liquidation LTV 99.99%.'
    const withAddress = assessment([finding(`collateral.${address}.ltv`, {
      cause: { code: 'collateral-ltv-out-of-range', subject: address, summary, remedy: null },
    })])
    expect(getVaultCheckFindings(withAddress).lines[0]?.parts).toEqual([
      { text: 'Collateral ' },
      { text: '0xf037ee…43c8', address },
      { text: ' has liquidation LTV 99.99%.' },
    ])

    const withoutAddress = assessment([finding('collateral.0x01.ltv', {
      cause: { code: 'collateral-ltv-out-of-range', subject: 'vault', summary, remedy: null },
    })])
    expect(getVaultCheckFindings(withoutAddress).lines[0]?.parts).toBeUndefined()
  })

  it('lists every counted failure under the row, the adapter and evidence rules included, and names an undecided check by its cause', () => {
    const lines = getVaultCheckWarningLines(assessment([
      finding('oracle.adapters-recognized'),
      finding('evidence.safe-threshold'),
      finding('oracle.liability-quote', { outcome: 'unknown', required: true, cause: { code: 'adapters-pending', subject: 'vault', summary: 'Euler has not finished checking 4 adapters on the oracle routes.', remedy: null } }),
      finding('liquidation.max-discount', { outcome: 'unknown' }),
      finding('irm.max-apy', { exempted: true }),
      finding('deployment.factory', { outcome: 'pass' }),
    ]))
    expect(lines.map(line => [line.key, line.outcome, line.text])).toEqual([
      ['oracle.adapters-recognized', 'fail', 'V3 says oracle.adapters-recognized'],
      ['evidence.safe-threshold', 'fail', 'V3 says evidence.safe-threshold'],
      ['oracle.liability-quote', 'unknown', 'Euler has not finished checking 4 adapters on the oracle routes.'],
    ])
  })

  it('names why an unknown vault is unknown without calling a labelled vault unlisted', () => {
    expect(getUnknownVaultCause(undefined)).toBe('This vault is not listed in the published vault labels.')
    expect(getUnknownVaultCause({ status: 'hidden', reason: 'Deprecated due to low activity.', decidedBy: 'deprecated' })).toBe('This vault is not listed: Deprecated due to low activity.')
    expect(getUnknownVaultCause({ status: 'pending_review', decidedBy: 'unclaimed' })).toBe('This vault is not listed in the published vault labels.')
    expect(getUnknownVaultCause({ status: 'pending_review', decidedBy: 'checks' })).toBe('This vault has not been checked yet, so it is not listed.')
    expect(getUnknownVaultCause({ status: 'warning', reason: 'Deprecated due to low activity.', decidedBy: 'deprecated' })).toBe('This vault is in the published vault labels but could not be verified.')
  })

  it('colours a finding red only when it keeps the vault from being listed', () => {
    expect(getVaultCheckFindingTone(finding('oracle.adapters-recognized', { outcome: 'unknown', required: true }))).toBe('error')
    expect(getVaultCheckFindingTone(finding('oracle.liability-quote', { required: true }))).toBe('error')
    expect(getVaultCheckFindingTone(finding('irm.max-apy'))).toBe('warning')
    expect(getVaultCheckFindingTone(finding('liquidation.max-discount', { outcome: 'unknown' }))).toBe('warning')
    expect(getVaultCheckFindingTone(finding('governance.timelock', { required: true, exempted: true }))).toBe('warning')
    expect(getVaultCheckFindingTone(finding('deployment.factory', { outcome: 'pass' }))).toBe('pass')
    expect(getVaultCheckFindingTone(finding('market.asset-present', { outcome: 'not_applicable' }))).toBe('muted')
  })

  it('counts accepted exceptions as passed in the row cell and puts failures first', () => {
    const accepted = finding('liquidation.max-discount', { outcome: 'fail', required: false, exempted: true })
    const passed = finding('oracle.liability-quote', { outcome: 'pass' })
    expect(getVaultChecksCell(assessment([accepted, passed, finding('irm.max-apy', { outcome: 'pass' })]))).toEqual({ text: '3 passed', tone: 'positive' })
    expect(getVaultChecksCell(assessment([accepted, finding('oracle.liability-route')]))).toEqual({ text: '1 failed', tone: 'warning' })
    expect(getVaultChecksCell(assessment([finding('oracle.liability-route', { outcome: 'unknown' }), passed]))).toEqual({ text: '1 unknown', tone: 'muted' })
    expect(getVaultChecksCell(assessment([finding('oracle.adapters-recognized', { outcome: 'unknown', required: true }), passed]))).toEqual({ text: '1 unknown', tone: 'warning' })
    expect(getVaultChecksCell(assessment([finding('irm.max-apy'), finding('liquidation.max-discount', { outcome: 'unknown' }), passed]))).toEqual({ text: '1 failed · 1 unknown', tone: 'warning' })
    expect(getVaultChecksCell(assessment([], { assessed: false }))).toEqual({ text: 'Not assessed', tone: 'muted' })
  })

  it('distinguishes passing, flagged, missing and unavailable states', () => {
    const now = Date.parse('2026-09-29T12:12:00.000Z')
    expect(getVaultChecksStatusLine(assessment([]), 'available', now)).toBe('Checks passed · checked 12 min ago')
    expect(getVaultChecksStatusLine(assessment([finding('oracle.liability-quote')]), 'available', now)).toBe('Warning · 1 to review')
    expect(getVaultChecksStatusLine(assessment([], { checksStatus: null }), 'available', now)).toBe('Being re-checked')
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
    expect(getNotListedLine('pending_review', null, 'unclaimed')).toBe('This vault is not listed in the published vault labels.')
    const address = '0x0000000000000000000000000000000000000001'
    const visibility = { [address]: { status: 'hidden', reason: 'The check failed' } }
    expect(getKnownUnlistedActionNotice([address], 'v3', visibility)).toBe('This vault is not listed: The check failed.')
    expect(getKnownUnlistedActionNotice([address], 'v3', { [address]: { status: 'pending_review' } })).toBe('This vault has not been checked yet, so it is not listed.')
    expect(getKnownUnlistedActionNotice([address], 'v3', { [address]: { status: 'pending_review', decidedBy: 'unclaimed' } })).toBe('This vault is not listed in the published vault labels.')
    expect(getKnownUnlistedActionNotice([address], 'static', visibility)).toBeNull()
    expect(getKnownUnlistedActionNotice([address, '0x0000000000000000000000000000000000000002'], 'v3', visibility)).toBeNull()
  })

  it('gives forms and batch review one non-duplicated action explanation', () => {
    expect(getUnverifiedActionCopy('These vaults are not listed.').description).toBe(
      'These vaults are not listed. Review the vault details and confirm you trust the source before continuing.',
    )
    expect(getUnverifiedActionCopy(null, ['Vault A']).description).toContain('Vault A')
    expect(getUnverifiedActionCopy(null, ['Vault A']).description).toContain('phishing attempts')
  })
})
