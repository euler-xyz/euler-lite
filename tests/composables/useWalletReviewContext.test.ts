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

  it('defers closing during submission and invalidates when submission settles', () => {
    const scope = effectScope()
    const account = ref<Address | undefined>(OWNER)
    const chainId = ref<number | undefined>(1)
    const isSubmitting = ref(true)
    const onInvalidated = vi.fn()
    const result = scope.run(() => useWalletReviewContext({ account, chainId, isSubmitting, onInvalidated }))!

    account.value = OTHER_OWNER
    expect(result.isReviewWalletContextInvalidated.value).toBe(false)
    expect(onInvalidated).not.toHaveBeenCalled()

    isSubmitting.value = false
    expect(result.isReviewWalletContextInvalidated.value).toBe(true)
    expect(onInvalidated).toHaveBeenCalledWith('account')
    scope.stop()
  })
})
