import { describe, expect, it } from 'vitest'
import {
  getFlaggedActionNotice,
  getFlaggedOpeningText,
  getFlaggedTransactionLine,
  getFlaggedVaultLine,
  getFlaggedVerdict,
  getVaultOpeningNotice,
  isDeprecationWarning,
} from '~/utils/vault-assessment/flagged'

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
