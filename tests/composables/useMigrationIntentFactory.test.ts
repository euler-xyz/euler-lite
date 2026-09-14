import { getAddress, type Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { useMigrationIntentFactory } from '~/composables/useMigrationIntentFactory'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')

describe('useMigrationIntentFactory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves the explicit plan deadline when authorization uses transactions', () => {
    vi.stubGlobal('useOperationIntentFactory', () => ({
      create: (input: Record<string, unknown>) => ({
        ...input,
        planner: { name: input.planner, args: input.args },
      }) as unknown as OperationIntent,
    }))
    const deadline = 2_000_000_000n

    const intent = useMigrationIntentFactory().createMigrationIntent({
      args: { direction: 'external-to-euler', deadline },
      source: 'test:migration',
      subAccounts: [ACCOUNT as Address],
      bounds: [],
    })

    expect(intent.planner.args.deadline).toBe(deadline)
  })
})
