import { describe, expect, it } from 'vitest'
import {
  getFlaggedActionNotice,
  getFlaggedOpeningText,
  getFlaggedTransactionLine,
  getFlaggedVaultLine,
  getFlaggedVerdict,
  getVaultOpeningNotice,
  isDeprecationWarning,
  isHiddenForNonGovernanceCause,
  isPausedVerdict,
} from '~/utils/vault-assessment/flagged'
import { liquityHubHiddenVerdict } from '~/tests/fixtures/liquity-hub'
import {
  EUSDC_42_RAW_ASSESSMENT,
  EUSDC_95_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT_VERDICT,
  assessmentEntry,
} from '~/tests/fixtures/v3-hidden-vault-assessments'

const FLAGGED = '0x00000000000000000000000000000000000000a1'
const PENDING = '0x00000000000000000000000000000000000000a2'
const LISTED = '0x00000000000000000000000000000000000000a3'
const UNLABELLED = '0x00000000000000000000000000000000000000a4'

const visibility = {
  [FLAGGED]: { status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed' },
  [PENDING]: { status: 'pending_review', decidedBy: 'awaiting-verification', reason: null },
  [LISTED]: { status: 'visible', decidedBy: 'verified', reason: null },
}
const isVerified = (address: string) => address.toLowerCase() === LISTED

describe('flagged vault copy', () => {
  it('words the line under the name with the V3 reason', () => {
    expect(getFlaggedVaultLine('A required check failed')).toBe('Euler\'s checks flagged this vault: A required check failed.')
    expect(getFlaggedVaultLine('The oracle is stale.')).toBe('Euler\'s checks flagged this vault: The oracle is stale.')
    expect(getFlaggedVaultLine(null)).toBe('Euler\'s checks flagged this vault.')
  })

  it('words the transaction confirmation with the V3 reason', () => {
    expect(getFlaggedTransactionLine('A required check failed')).toBe('This transaction uses a flagged vault: A required check failed.')
    expect(getFlaggedTransactionLine(undefined)).toBe('This transaction uses a flagged vault.')
  })

  it('words the opening pop-up with the V3 reason', () => {
    expect(getFlaggedOpeningText(['A required check failed'])).toBe(
      'Euler\'s checks flagged this vault: A required check failed. Continue only if you understand the risk.',
    )
    expect(getFlaggedOpeningText(['Same reason', 'Same reason'])).toBe(
      'Euler\'s checks flagged this vault: Same reason. Continue only if you understand the risk.',
    )
  })
})

describe('flagged vault verdict', () => {
  it('flags only a V3 hidden verdict', () => {
    expect(getFlaggedVerdict(FLAGGED, 'v3', visibility)?.reason).toBe('A required check failed')
    expect(getFlaggedVerdict(FLAGGED.toUpperCase().replace('0X', '0x'), 'v3', visibility)).toBeDefined()
    expect(getFlaggedVerdict(PENDING, 'v3', visibility)).toBeUndefined()
    expect(getFlaggedVerdict(LISTED, 'v3', visibility)).toBeUndefined()
    expect(getFlaggedVerdict(UNLABELLED, 'v3', visibility)).toBeUndefined()
    expect(getFlaggedVerdict(FLAGGED, 'static', visibility)).toBeUndefined()
    expect(getFlaggedVerdict(FLAGGED, 'v3-metadata', visibility)).toBeUndefined()
  })

  it('uses the flagged confirmation only when every vault in the transaction is flagged', () => {
    expect(getFlaggedActionNotice([FLAGGED], 'v3', visibility)).toBe('This transaction uses a flagged vault: A required check failed.')
    expect(getFlaggedActionNotice([PENDING], 'v3', visibility)).toBeNull()
    expect(getFlaggedActionNotice([FLAGGED, PENDING], 'v3', visibility)).toBeNull()
    expect(getFlaggedActionNotice([FLAGGED, UNLABELLED], 'v3', visibility)).toBeNull()
    expect(getFlaggedActionNotice([FLAGGED], 'static', visibility)).toBeNull()
    expect(getFlaggedActionNotice([], 'v3', visibility)).toBeNull()
  })
})

describe('vault opening notice', () => {
  const notice = (addresses: string[], source = 'v3') => getVaultOpeningNotice(addresses, { isVerified, source, visibility })

  it('asks the strict question for a vault with no verdict or a pending verdict', () => {
    expect(notice([UNLABELLED])).toEqual({ kind: 'unknown' })
    expect(notice([PENDING])).toEqual({ kind: 'unknown' })
    expect(notice([UNLABELLED], 'static')).toEqual({ kind: 'unknown' })
  })

  it('uses the flagged notice for a hidden vault', () => {
    expect(notice([FLAGGED])).toEqual({
      kind: 'flagged',
      text: 'Euler\'s checks flagged this vault: A required check failed. Continue only if you understand the risk.',
    })
    expect(notice([LISTED, FLAGGED])).toMatchObject({ kind: 'flagged' })
  })

  it('keeps the strict question when one side is unknown and the other flagged', () => {
    expect(notice([FLAGGED, PENDING])).toEqual({ kind: 'unknown' })
  })

  it('shows nothing for listed vaults', () => {
    expect(notice([LISTED])).toBeNull()
    expect(notice([])).toBeNull()
  })
})

describe('isDeprecationWarning', () => {
  const deprecated = { status: 'warning', decidedBy: 'deprecated', reason: null }

  it('treats a deprecation verdict as the Deprecated badge when labels carry the deprecation', () => {
    expect(isDeprecationWarning(deprecated, true)).toBe(true)
  })

  it('keeps the warning when labels do not show the vault as deprecated', () => {
    expect(isDeprecationWarning(deprecated, false)).toBe(false)
  })

  it('keeps warnings decided by anything other than deprecation', () => {
    expect(isDeprecationWarning({ status: 'warning', decidedBy: 'advisories', reason: null }, true)).toBe(false)
  })

  it('keeps hidden verdicts and missing verdicts out', () => {
    expect(isDeprecationWarning({ status: 'hidden', decidedBy: 'deprecated', reason: null }, true)).toBe(false)
    expect(isDeprecationWarning(undefined, true)).toBe(false)
  })
})

describe('a hidden vault whose assessment shows no governance cause', () => {
  const paused = liquityHubHiddenVerdict('config-suspended')
  const withFindings = (findings: Array<Record<string, unknown>>) => ({
    ...EUSDC_42_RAW_ASSESSMENT,
    configContext: { ...EUSDC_42_RAW_ASSESSMENT.configContext, findings: [...EUSDC_42_RAW_ASSESSMENT.configContext.findings, ...findings] },
  }) as typeof EUSDC_42_RAW_ASSESSMENT

  it('accepts a paused vault whose governance findings pass and whose consistency is verified', () => {
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(EUSDC_42_RAW_ASSESSMENT))).toBe(true)
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(EUSDC_42_RAW_ASSESSMENT, { consistencyStatus: 'not_applicable' }))).toBe(true)
  })

  it('rejects the Idle DAO credit vault, hidden as config-failed by a deprecated governor', () => {
    expect(isHiddenForNonGovernanceCause(IDLE_CREDIT_VAULT_VERDICT, assessmentEntry(IDLE_CREDIT_VAULT_RAW_ASSESSMENT))).toBe(false)
  })

  it.each([
    ['a failing scheduled governance change', { key: 'scheduled.governance.timelock', outcome: 'fail', required: false, description: 'Timelock', cause: null }],
    ['a required governance rule that could not run', { key: 'governance.router', outcome: 'unknown', required: true, description: 'Router', cause: null }],
  ])('rejects %s', (_label, finding) => {
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(withFindings([finding])))).toBe(false)
  })

  it.each(['suspended', 'revoked', 'pending', null])('rejects consistency %s, which a config verdict can mask', (consistencyStatus) => {
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(EUSDC_42_RAW_ASSESSMENT, { consistencyStatus }))).toBe(false)
  })

  it('keeps the curator blank while the assessment loads or is unavailable', () => {
    expect(isHiddenForNonGovernanceCause(paused, { status: 'loading' })).toBe(false)
    expect(isHiddenForNonGovernanceCause(paused, { status: 'unavailable' })).toBe(false)
    expect(isHiddenForNonGovernanceCause(paused, undefined)).toBe(false)
  })

  it.each(['not-explorable', 'consistency-suspended', 'consistency-revoked', 'a-reason-v3-adds-later', undefined])('rejects the hidden reason %s', (decidedBy) => {
    expect(isHiddenForNonGovernanceCause({ ...paused, decidedBy }, assessmentEntry(EUSDC_42_RAW_ASSESSMENT))).toBe(false)
  })

  it('accepts config-revoked only when a non-governance failure explains it', () => {
    const revoked = liquityHubHiddenVerdict('config-revoked')
    const clean = { ...EUSDC_42_RAW_ASSESSMENT, configContext: { ...EUSDC_42_RAW_ASSESSMENT.configContext, findings: [] } }
    expect(isHiddenForNonGovernanceCause(revoked, assessmentEntry(clean))).toBe(false)
    expect(isHiddenForNonGovernanceCause(revoked, assessmentEntry(EUSDC_42_RAW_ASSESSMENT))).toBe(true)
  })

  const withContext = (configContext: Record<string, unknown>) => ({
    ...EUSDC_42_RAW_ASSESSMENT,
    configContext: { ...EUSDC_42_RAW_ASSESSMENT.configContext, ...configContext },
  }) as typeof EUSDC_42_RAW_ASSESSMENT
  const failing = (key: string) => ({ key, outcome: 'fail', required: true, description: key, cause: null })
  const passing = (key: string) => ({ key, outcome: 'pass', required: true, description: key, cause: null })

  it('rejects an assessment where the governance rules never ran', () => {
    const lensOnly = withContext({ findings: [failing('configuration.lens-readable')] })
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(lensOnly))).toBe(false)
  })

  it.each([
    ['euler-evk', [passing('governance.no-deprecated-governor')], false],
    ['euler-evk', [passing('governance.no-deprecated-governor'), passing('governance.router')], true],
    ['euler-securitize', [passing('governance.no-deprecated-governor')], true],
    ['euler-securitize', [], false],
    ['euler-earn', [], false],
    ['euler-earn', [{ ...passing('governance.timelock'), outcome: 'not_applicable' }], true],
    ['a-policy-lite-does-not-know', [passing('governance.no-deprecated-governor'), passing('governance.router')], false],
  ])('requires the %s governance rules to be present: %#', (policyId, governance, expected) => {
    const context = withContext({ policyId, findings: [failing('hooks.zero-or-trusted'), ...governance] })
    expect(isHiddenForNonGovernanceCause(paused, assessmentEntry(context))).toBe(expected)
  })

  it('only applies to a hidden verdict', () => {
    expect(isHiddenForNonGovernanceCause({ ...paused, status: 'warning' }, assessmentEntry(EUSDC_42_RAW_ASSESSMENT))).toBe(false)
  })
})

describe('paused verdict', () => {
  const hidden = (decidedBy: string) => ({ status: 'hidden', decidedBy })
  const exitsOff = assessmentEntry(EUSDC_95_RAW_ASSESSMENT).assessment

  it.each(['config-suspended', 'config-failed', 'config-revoked'])('needs on-chain or assessment pause evidence for %s', (decidedBy) => {
    expect(isPausedVerdict(hidden(decidedBy), { family: 'evk', onchainPaused: true })).toBe(true)
    expect(isPausedVerdict(hidden(decidedBy), { family: 'evk', assessment: exitsOff })).toBe(true)
    expect(isPausedVerdict(hidden(decidedBy), { family: 'evk' })).toBe(false)
  })

  it('does not take an untrusted hook target or an unrelated failure as a pause', () => {
    const otherFailure = assessmentEntry(IDLE_CREDIT_VAULT_RAW_ASSESSMENT).assessment
    expect(isPausedVerdict(hidden('config-failed'), { family: 'evk', assessment: otherFailure })).toBe(false)
  })

  it('lets the loaded vault decide over an assessment that may be older', () => {
    expect(isPausedVerdict(hidden('config-failed'), { family: 'evk', onchainPaused: false, assessment: exitsOff })).toBe(false)
  })

  it('never calls an Earn vault paused', () => {
    expect(isPausedVerdict(hidden('config-suspended'), { family: 'earn', onchainPaused: true, assessment: exitsOff })).toBe(false)
  })

  it.each(['consistency-suspended', 'not-explorable'])('keeps %s flagged', (decidedBy) => {
    expect(isPausedVerdict(hidden(decidedBy), { family: 'evk', onchainPaused: true })).toBe(false)
  })
})
