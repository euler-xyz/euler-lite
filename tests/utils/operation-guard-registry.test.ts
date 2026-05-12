import { afterEach, describe, expect, it } from 'vitest'
import {
  assertOperationNotBlocked,
  isOperationBlocked,
  operationBlockReason,
  registerOperationBlocker,
  unregisterOperationBlocker,
} from '~/utils/operationGuardRegistry'

describe('operation guard registry blockers', () => {
  afterEach(() => {
    unregisterOperationBlocker('test-compliance')
  })

  it('allows execution when no blocker is active', () => {
    unregisterOperationBlocker('test-compliance')

    expect(isOperationBlocked.value).toBe(false)
    expect(() => assertOperationNotBlocked()).not.toThrow()
  })

  it('throws the active blocker reason for final execution gates', () => {
    registerOperationBlocker('test-compliance', 'Checking wallet compliance')

    expect(isOperationBlocked.value).toBe(true)
    expect(operationBlockReason.value).toBe('Checking wallet compliance')
    expect(() => assertOperationNotBlocked()).toThrow('Checking wallet compliance')
  })
})
