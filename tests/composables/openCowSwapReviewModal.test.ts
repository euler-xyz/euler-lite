import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { openCowSwapReviewModal } from '~/composables/cowswap/openCowSwapReviewModal'
import { registerOperationPolicyCheck, unregisterOperationPolicyCheck } from '~/utils/operationGuardRegistry'

vi.mock('#components', () => ({ CowSwapReviewModal: {} }))

describe('openCowSwapReviewModal policy freshness', () => {
  it('re-checks captured policy when the user confirms after navigation', async () => {
    const policyBlocked = ref(false)
    const executeAsync = vi.fn()
    const modal = { open: vi.fn() }

    registerOperationPolicyCheck(
      'test-cow-policy',
      () => policyBlocked.value ? 'CoW operation policy changed' : undefined,
    )

    openCowSwapReviewModal(modal as never, {
      signSteps: [],
      wrapperSteps: [],
      walletWarningsDescription: '',
      execution: {
        status: ref('idle'),
        error: ref(null),
        explorerUrl: ref(undefined),
        locallyCancelled: ref(false),
        cancellationMode: ref(undefined),
        cancellationStatus: ref('none'),
        executeAsync,
        cancelOrder: vi.fn(),
      } as never,
      orderStatus: { orderStatus: ref(null) },
      executeParams: {},
      logPrefix: 'test/cow',
    })

    unregisterOperationPolicyCheck('test-cow-policy')
    policyBlocked.value = true
    const modalOptions = modal.open.mock.calls[0]?.[1] as { props: { onConfirm: () => Promise<void> } }
    await modalOptions.props.onConfirm()

    expect(executeAsync).not.toHaveBeenCalled()
  })
})
