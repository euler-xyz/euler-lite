import { describe, expect, it } from 'vitest'
import { isOperationBlockerKey } from '~/utils/operationGuardRegistry'

describe('operation blocker namespaces', () => {
  it('matches both legacy and instance-scoped blocker keys', () => {
    expect(isOperationBlockerKey('tos', 'tos')).toBe(true)
    expect(isOperationBlockerKey('tos:1', 'tos')).toBe(true)
    expect(isOperationBlockerKey('tos-load', 'tos')).toBe(false)
    expect(isOperationBlockerKey('keyring', 'tos')).toBe(false)
  })
})
