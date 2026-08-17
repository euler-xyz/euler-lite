import type { Address } from 'viem'
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useWalletReviewContext } from '~/composables/useWalletReviewContext'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OTHER_OWNER = '0x2222222222222222222222222222222222222222' as Address

describe('useWalletReviewContext', () => {
  it.each([
    { label: 'account', nextAccount: OTHER_OWNER, nextChainId: 1, expectedChange: 'account' },
    { label: 'network', nextAccount: OWNER, nextChainId: 8453, expectedChange: 'chain' },
  ])('invalidates an open review immediately after a $label change', ({ nextAccount, nextChainId, expectedChange }) => {
    const scope = effectScope()
    const account = ref<Address | undefined>(OWNER)
    const chainId = ref<number | undefined>(1)
    const isSubmitting = ref(false)
    const onInvalidated = vi.fn()
    const result = scope.run(() => useWalletReviewContext({ account, chainId, isSubmitting, onInvalidated }))!

    account.value = nextAccount
    chainId.value = nextChainId

    expect(result.isReviewWalletContextInvalidated.value).toBe(true)
    expect(onInvalidated).toHaveBeenCalledOnce()
    expect(onInvalidated).toHaveBeenCalledWith(expectedChange)
    scope.stop()
  })

  it.each([
    {
      label: 'account',
      expectedChange: 'account',
      drift: (account: { value: Address | undefined }, _chainId: { value: number | undefined }) => { account.value = OTHER_OWNER },
    },
    {
      label: 'network',
      expectedChange: 'chain',
      drift: (_account: { value: Address | undefined }, chainId: { value: number | undefined }) => { chainId.value = 8453 },
    },
  ])('latches a $label round-trip during submission and closes when submission settles', ({ drift, expectedChange }) => {
    const scope = effectScope()
    const account = ref<Address | undefined>(OWNER)
    const chainId = ref<number | undefined>(1)
    const isSubmitting = ref(true)
    const onInvalidated = vi.fn()
    const result = scope.run(() => useWalletReviewContext({ account, chainId, isSubmitting, onInvalidated }))!

    drift(account, chainId)
    expect(result.isReviewWalletContextInvalidated.value).toBe(true)
    expect(onInvalidated).not.toHaveBeenCalled()

    account.value = OWNER
    chainId.value = 1
    expect(result.isReviewWalletContextInvalidated.value).toBe(true)
    expect(onInvalidated).not.toHaveBeenCalled()

    isSubmitting.value = false
    expect(result.isReviewWalletContextInvalidated.value).toBe(true)
    expect(onInvalidated).toHaveBeenCalledOnce()
    expect(onInvalidated).toHaveBeenCalledWith(expectedChange)
    scope.stop()
  })
})
