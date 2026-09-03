import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hash, StateOverride } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { useExecutionReview } from '~/composables/useExecutionReview'

const { modalOpen, operationModal, reviewedOperationModal, isSpyMode } = vi.hoisted(() => ({
  modalOpen: vi.fn(),
  operationModal: { name: 'OperationReviewModal' },
  reviewedOperationModal: { name: 'ReviewedOperationModal' },
  isSpyMode: { value: false },
}))

vi.mock('#components', () => ({
  OperationReviewModal: operationModal,
  ReviewedOperationModal: reviewedOperationModal,
}))
vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: modalOpen }),
}))

const reviewId = `0x${'1'.repeat(64)}` as Hash
const reviewDigest = `0x${'2'.repeat(64)}` as Hash

describe('useExecutionReview', () => {
  beforeEach(() => {
    modalOpen.mockReset()
    isSpyMode.value = false
    vi.stubGlobal('useEffectiveAddress', () => ({ isSpyMode }))
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
      presentationInputs: expect.objectContaining(review),
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

  it('captures presentation inputs before asynchronous preparation', async () => {
    let resolvePrepare: ((value: {
      execution: { reviewId: Hash, reviewDigest: Hash }
      prepared: TransactionPlanPrepared
    }) => void) | undefined
    const executablePrepared = { chainId: 1, plan: [{ type: 'executable' }] } as unknown as TransactionPlanPrepared
    const prepare = vi.fn(() => new Promise<{
      execution: { reviewId: Hash, reviewDigest: Hash }
      prepared: TransactionPlanPrepared
    }>((resolve) => {
      resolvePrepare = resolve
    }))
    vi.stubGlobal('useReviewedExecution', () => ({ prepare }))
    const review = {
      asset: { address: '0x2000000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
      amount: '1',
      type: 'repay',
    }

    const opening = useExecutionReview().open([], {
      presentationKind: 'repay',
      review,
    })
    review.amount = '2'
    review.asset.symbol = 'DAI'
    resolvePrepare?.({ execution: { reviewId, reviewDigest }, prepared: executablePrepared })
    await opening

    expect(prepare).toHaveBeenCalledWith([], {
      presentationKind: 'repay',
      presentationInputs: expect.objectContaining({
        amount: '1',
        asset: expect.objectContaining({ symbol: 'USDC' }),
      }),
    })
    expect(modalOpen.mock.calls[0]?.[1].props.review).toMatchObject({
      amount: '1',
      asset: { symbol: 'USDC' },
    })
  })

  it('opens a non-executable prepared preview in spy mode', async () => {
    isSpyMode.value = true
    const readOnlyPrepared = { chainId: 1, plan: [{ type: 'preview' }] } as unknown as TransactionPlanPrepared
    const requests = [{
      requestId: `0x${'3'.repeat(64)}`,
      chainId: 1,
      from: '0x1000000000000000000000000000000000000000',
      to: '0x2000000000000000000000000000000000000000',
      data: '0x1234',
      value: 0n,
      effectIds: [],
      phase: 'core',
    }]
    const prepare = vi.fn()
    const prepareReadOnly = vi.fn(async () => ({
      execution: {
        reviewId,
        reviewDigest,
        requestSet: {
          wallet: {
            account: '0x1000000000000000000000000000000000000000',
            walletKind: 'eoa',
          },
          requests,
          signatureSlots: [],
        },
      },
      prepared: readOnlyPrepared,
      readOnly: true,
    }))
    vi.stubGlobal('useReviewedExecution', () => ({ prepare, prepareReadOnly }))
    const review = {
      asset: { address: '0x2000000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
      amount: '1',
      type: 'repay',
    }

    await useExecutionReview().open([], {
      presentationKind: 'repay',
      review,
    })

    expect(prepare).not.toHaveBeenCalled()
    expect(prepareReadOnly).toHaveBeenCalledWith([], {
      presentationKind: 'repay',
      presentationInputs: review,
    })
    expect(modalOpen).toHaveBeenCalledWith(operationModal, {
      props: expect.objectContaining({
        ...review,
        prepared: readOnlyPrepared,
        calldataPrepared: readOnlyPrepared,
        tenderlyPrepared: readOnlyPrepared,
        reviewedAccount: '0x1000000000000000000000000000000000000000',
        reviewedWalletKind: 'eoa',
        reviewedRequests: requests,
        reviewedSignatureSlots: [],
        readOnly: true,
      }),
    })
  })
})
