/**
 * Unit tests for the support panel's server helpers.
 *
 * These are pure-function tests — they do not boot Nitro and never reach
 * HelpScout. They lock in the guards that keep an unconfigured deployment from
 * pretending support works, and the email validation both endpoints rely on.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { helpScoutConfig, isEmail, isSupportConfigured } from '~/server/utils/helpscout'

const HELPSCOUT_KEYS = [
  'HELPSCOUT_DOCS_API_KEY',
  'HELPSCOUT_DOCS_COLLECTION_ID',
  'HELPSCOUT_APP_ID',
  'HELPSCOUT_APP_SECRET',
  'HELPSCOUT_MAILBOX_ID',
] as const

// Empty is equivalent to unset for helpScoutConfig(): the string fields fall back
// to '' and Number('') is 0, so both read as "not configured".
const clearEnv = () => {
  for (const key of HELPSCOUT_KEYS) process.env[key] = ''
}

afterEach(clearEnv)

describe('isEmail', () => {
  it('accepts a plain address', () => {
    expect(isEmail('someone@example.com')).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['not-an-email', 'no @'],
    ['a@b', 'no dot in domain'],
    ['a b@example.com', 'whitespace'],
    ['@example.com', 'no local part'],
  ])('rejects %j (%s)', (value) => {
    expect(isEmail(value)).toBe(false)
  })
})

describe('isSupportConfigured', () => {
  it('is false when nothing is configured', () => {
    clearEnv()
    expect(isSupportConfigured()).toBe(false)
  })

  it('is false when the mailbox id is missing', () => {
    clearEnv()
    process.env.HELPSCOUT_APP_ID = 'id'
    process.env.HELPSCOUT_APP_SECRET = 'secret'
    expect(isSupportConfigured()).toBe(false)
  })

  it('is false when the mailbox id is not a number', () => {
    clearEnv()
    process.env.HELPSCOUT_APP_ID = 'id'
    process.env.HELPSCOUT_APP_SECRET = 'secret'
    process.env.HELPSCOUT_MAILBOX_ID = 'not-a-number'
    expect(isSupportConfigured()).toBe(false)
  })

  it('is true once app id, secret and mailbox id are all present', () => {
    clearEnv()
    process.env.HELPSCOUT_APP_ID = 'id'
    process.env.HELPSCOUT_APP_SECRET = 'secret'
    process.env.HELPSCOUT_MAILBOX_ID = '42'
    expect(isSupportConfigured()).toBe(true)
  })
})

describe('helpScoutConfig', () => {
  it('defaults to empty strings and a zero mailbox id', () => {
    clearEnv()
    expect(helpScoutConfig()).toEqual({
      docsKey: '',
      collectionId: '',
      appId: '',
      appSecret: '',
      mailboxId: 0,
    })
  })

  it('coerces the mailbox id to a number', () => {
    clearEnv()
    process.env.HELPSCOUT_MAILBOX_ID = '12345'
    expect(helpScoutConfig().mailboxId).toBe(12345)
  })
})
