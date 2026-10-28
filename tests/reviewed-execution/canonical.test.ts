import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { assertCanonicalValue, canonicalDigest, deepFreezeCanonical } from '~/features/reviewed-execution/domain/canonical'
import { assertOperationIntent } from '~/features/reviewed-execution/domain/schemas'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')

describe('canonical reviewed execution encoding', () => {
  it('is deterministic across object insertion order and address casing', () => {
    const first = {
      schemaVersion: 1,
      account: ACCOUNT,
      nested: { amount: 12n, enabled: true },
      ordered: ['one', 'two'],
    }
    const second = {
      ordered: ['one', 'two'],
      nested: { enabled: true, amount: 12n },
      account: ACCOUNT.toLowerCase(),
      schemaVersion: 1,
    }

    expect(canonicalDigest('reviewed-request-set-v1', first))
      .toBe(canonicalDigest('reviewed-request-set-v1', second))
  })

  it('commits to the schema and array order', () => {
    const value = { calls: ['0x01', '0x02'] }
    expect(canonicalDigest('reviewed-request-set-v1', value))
      .not.toBe(canonicalDigest('reviewed-request-set-v2', value))
    expect(canonicalDigest('reviewed-request-set-v1', value))
      .not.toBe(canonicalDigest('reviewed-request-set-v1', { calls: ['0x02', '0x01'] }))
  })

  it.each([
    () => undefined,
    () => Symbol('bad'),
    () => 1.5,
    () => Number.MAX_SAFE_INTEGER + 1,
    () => ({ callback: () => undefined }),
    () => ({ ref: { __v_isRef: true, value: 1 } }),
    () => ({ date: new Date() }),
    () => ({ map: new Map() }),
  ])('rejects non-canonical runtime data', (build) => {
    expect(() => assertCanonicalValue(build())).toThrow()
  })

  it('deep-freezes validated values', () => {
    const value = deepFreezeCanonical({ nested: { amount: 1n }, items: [1, 2] })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.nested)).toBe(true)
    expect(Object.isFrozen(value.items)).toBe(true)
  })
})

describe('operation intent schema', () => {
  const intent = {
    schemaVersion: 1,
    intentId: 'intent-1',
    revision: 0,
    kind: 'deposit',
    chainId: 1,
    account: ACCOUNT,
    subAccounts: [ACCOUNT],
    planner: { name: 'deposit', args: { vaultAddress: ACCOUNT, assetAddress: ACCOUNT, amount: 1n } },
    constraints: [{ kind: 'exact-input', token: ACCOUNT, amount: 1n }],
    metadata: { createdAt: 1, source: 'test', operation: 'test' },
  } as const

  it('accepts a serializable intent DTO', () => {
    expect(() => assertOperationIntent(intent)).not.toThrow()
  })

  it('rejects unknown fields and mutable runtime objects', () => {
    expect(() => assertOperationIntent({ ...intent, execute: () => undefined })).toThrow(/not supported/)
    expect(() => assertOperationIntent({ ...intent, planner: { ...intent.planner, args: { account: Object.create({ sdkAccount: true }) } } })).toThrow(/not supported|plain object/)
  })
})
