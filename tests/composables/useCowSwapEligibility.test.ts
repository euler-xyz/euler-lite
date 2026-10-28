import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useCowSwapEligibility', () => {
  let isSafeWallet: Ref<boolean>
  let isSafeWalletResolved: Ref<boolean>

  const setupComposable = async () => {
    const { useCowSwapEligibility } = await import('~/composables/useCowSwapEligibility')
    return useCowSwapEligibility()
  }

  beforeEach(() => {
    vi.resetModules()
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
  })

  it('allows CoW for resolved regular wallets', async () => {
    const { cowSwapForcedOff } = await setupComposable()
    expect(cowSwapForcedOff.value).toBe(false)
  })

  it('forces CoW off for Safe wallets', async () => {
    isSafeWallet.value = true
    const { cowSwapForcedOff } = await setupComposable()
    expect(cowSwapForcedOff.value).toBe(true)
  })

  it('fails closed while Safe detection is pending', async () => {
    isSafeWalletResolved.value = false
    const { cowSwapForcedOff } = await setupComposable()
    expect(cowSwapForcedOff.value).toBe(true)

    // Detection resolves to a regular wallet — CoW becomes available.
    isSafeWalletResolved.value = true
    expect(cowSwapForcedOff.value).toBe(false)
  })

  it('reacts to mid-session Safe connection', async () => {
    const { cowSwapForcedOff } = await setupComposable()
    expect(cowSwapForcedOff.value).toBe(false)

    isSafeWallet.value = true
    expect(cowSwapForcedOff.value).toBe(true)
  })
})
