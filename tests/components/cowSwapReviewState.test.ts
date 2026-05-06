import { describe, expect, it } from 'vitest'
import { resolveCowSwapReviewState } from '~/components/entities/operation/cowSwapReviewState'
import type { CowSwapOrderStatus } from '~/entities/cowswap'

const openOrder: CowSwapOrderStatus = {
  type: 'open',
  competitionType: 'open',
  orderType: 'open',
  terminal: false,
}

const expiredOrder: CowSwapOrderStatus = {
  type: 'expired',
  orderType: 'expired',
  terminal: true,
}

describe('resolveCowSwapReviewState', () => {
  it('keeps a soft-cancelled order from falling back to the open order label', () => {
    const state = resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: openOrder,
      locallyCancelled: true,
      cancellationMode: 'cow-api',
      cancellationStatus: 'soft_submitted',
      isLocallyCancelling: false,
    })

    expect(state.orderStatusLabel).toBe('Cancellation submitted — checking order status...')
    expect(state.canCancelOrder).toBe(false)
    expect(state.hasUnresolvedSubmittedOrder).toBe(true)
    expect(state.showSoftCancelWarning).toBe(true)
  })

  it('treats confirmed EVC nonce invalidation as terminal for the modal without implying CoW orderbook cancellation', () => {
    const state = resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: openOrder,
      locallyCancelled: true,
      cancellationMode: 'evc-permit',
      cancellationStatus: 'hard_confirmed',
      isLocallyCancelling: false,
    })

    expect(state.orderStatusLabel).toBe('Order settlement blocked')
    expect(state.orderStatusDescription).toContain('CoW Explorer may show open until expiry')
    expect(state.canCancelOrder).toBe(false)
    expect(state.hasUnresolvedSubmittedOrder).toBe(false)
  })

  it('uses terminal CoW order status once an EVC-invalidated order expires', () => {
    const state = resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: expiredOrder,
      locallyCancelled: true,
      cancellationMode: 'evc-permit',
      cancellationStatus: 'hard_confirmed',
      isLocallyCancelling: false,
    })

    expect(state.orderStatusLabel).toBe('Order expired')
    expect(state.orderStatusDescription).toBeUndefined()
    expect(state.orderStatusVariant).toBe('warning')
    expect(state.hasUnresolvedSubmittedOrder).toBe(false)
  })

  it('only shows the soft cancellation warning after CoW API cancellation was requested', () => {
    expect(resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: openOrder,
      locallyCancelled: false,
      cancellationMode: 'cow-api',
      cancellationStatus: 'none',
      isLocallyCancelling: false,
    }).showSoftCancelWarning).toBe(false)

    expect(resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: openOrder,
      locallyCancelled: true,
      cancellationMode: 'cow-api',
      cancellationStatus: 'soft_submitted',
      isLocallyCancelling: false,
    }).showSoftCancelWarning).toBe(true)

    expect(resolveCowSwapReviewState({
      executionStatus: 'submitted',
      orderStatus: openOrder,
      locallyCancelled: false,
      cancellationMode: 'evc-permit',
      cancellationStatus: 'none',
      isLocallyCancelling: false,
    }).showSoftCancelWarning).toBe(false)
  })
})
