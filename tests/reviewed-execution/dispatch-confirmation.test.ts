import { describe, expect, it, vi } from 'vitest'
import type { Hash, TransactionReceipt } from 'viem'
import { EoaExecutionAdapter } from '~/features/reviewed-execution/adapters/eoa'
import { SafeExecutionAdapter } from '~/features/reviewed-execution/adapters/safe'
import type { DispatchCallbacks } from '~/features/reviewed-execution/adapters/types'
import { artifactFor, makeReviewedExecution, materializedExecutorFor, TEST_EVC } from './fixtures'

const HASH = `0x${'01'.repeat(32)}` as Hash

const callbacks = (): DispatchCallbacks => ({
  assertWalletBinding: vi.fn(async () => {}),
  beforeDispatch: vi.fn(async () => {}),
  recordExternalId: vi.fn(async () => {}),
  markConfirming: vi.fn(async () => {}),
  afterConfirmed: vi.fn(async () => {}),
})

describe('reviewed execution confirmation metadata', () => {
  it('returns the final EOA receipt block', async () => {
    const execution = makeReviewedExecution()
    const adapter = new EoaExecutionAdapter(
      { sendTransaction: async () => HASH },
      materializedExecutorFor(async hash => ({
        transactionHash: hash,
        status: 'success',
        blockNumber: 123n,
      } as TransactionReceipt)),
      TEST_EVC,
    )

    const result = await adapter.dispatch(execution, artifactFor(execution), callbacks())

    expect(result).toMatchObject({
      transactionHashes: [HASH],
      confirmedBlockNumber: 123n,
    })
  })

  it('returns the confirmed Safe execution block', async () => {
    const execution = makeReviewedExecution('safe')
    const adapter = new SafeExecutionAdapter({
      assertAtomicCapability: async () => {},
      sendCalls: async () => HASH,
      waitForExecution: async () => ({
        executionHash: HASH,
        receiptStatus: 'success',
        confirmedBlockNumber: 456n,
        atomic: true,
      }),
    })

    const result = await adapter.dispatch(execution, artifactFor(execution), callbacks())

    expect(result).toMatchObject({
      transactionHashes: [HASH],
      executionHash: HASH,
      confirmedBlockNumber: 456n,
      atomic: true,
    })
  })
})
