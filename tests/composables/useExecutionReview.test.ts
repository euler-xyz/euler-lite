import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hash, StateOverride } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { useExecutionReview } from '~/composables/useExecutionReview'

const { modalOpen } = vi.hoisted(() => ({ modalOpen: vi.fn() }))

vi.mock('#components', () => ({ ReviewedOperationModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: modalOpen }),
}))

const reviewId = `0x${'1'.repeat(64)}` as Hash
const reviewDigest = `0x${'2'.repeat(64)}` as Hash

describe('useExecutionReview', () => {
  beforeEach(() => {
    modalOpen.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a dedicated Tenderly projection separate from the reviewed executable preview', async () => {
    const executablePrepared = { chainId: 1, plan: [{ type: 'executable' }] } as unknown as TransactionPlanPrepared
    const tenderlyPrepared = { chainId: 1, plan: [{ type: 'simulation' }] } as unknown as TransactionPlanPrepared
    const tenderlyStateOverrides = [{
      address: '0x1000000000000000000000000000000000000000',
      stateDiff: [],
    }] as StateOverride
    const prepare = vi.fn(async () => ({
      execution: { reviewId, reviewDigest },
      prepared: executablePrepared,
    }))
    vi.stubGlobal('useReviewedExecution', () => ({ prepare }))
    const review = {
      asset: { address: '0x2000000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
      amount: '1',
      type: 'migration',
    }

    await useExecutionReview().open([], {
      presentationKind: 'migration',
      review,
      tenderlyPrepared,
      tenderlyStateOverrides,
    })

    expect(prepare).toHaveBeenCalledWith([], {
      presentationKind: 'migration',
      presentationInputs: review,
    })
    expect(modalOpen).toHaveBeenCalledOnce()
    expect(modalOpen.mock.calls[0]?.[1].props.review).toMatchObject({
      plan: undefined,
      prepared: executablePrepared,
      calldataPrepared: executablePrepared,
      tenderlyPrepared,
      tenderlyStateOverrides,
    })
  })
})
