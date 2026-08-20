import { ref, type Ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seedSignaturePreference } from '~/composables/useSignaturePreference'
import { PERMIT2_PREFERENCE_STORAGE_KEY, SIGNATURES_PREFERENCE_STORAGE_KEY } from '~/entities/constants'

const createStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    snapshot: () => Object.fromEntries(store),
  }
}

describe('seedSignaturePreference', () => {
  let storage: ReturnType<typeof createStorage>

  beforeEach(() => {
    storage = createStorage()
  })

  it('carries an opted-out permit2 preference over to the signatures key', () => {
    storage = createStorage({ [PERMIT2_PREFERENCE_STORAGE_KEY]: 'false' })

    seedSignaturePreference(storage)

    expect(storage.snapshot()).toEqual({ [SIGNATURES_PREFERENCE_STORAGE_KEY]: 'false' })
  })

  it('carries an opted-in permit2 preference over as well', () => {
    storage = createStorage({ [PERMIT2_PREFERENCE_STORAGE_KEY]: 'true' })

    seedSignaturePreference(storage)

    expect(storage.getItem(SIGNATURES_PREFERENCE_STORAGE_KEY)).toBe('true')
  })

  it('removes the legacy key so seeding only ever runs once', () => {
    storage = createStorage({ [PERMIT2_PREFERENCE_STORAGE_KEY]: 'false' })

    seedSignaturePreference(storage)
    // A later opt-in must not be reverted by a second seed.
    storage.setItem(SIGNATURES_PREFERENCE_STORAGE_KEY, 'true')
    seedSignaturePreference(storage)

    expect(storage.getItem(SIGNATURES_PREFERENCE_STORAGE_KEY)).toBe('true')
    expect(storage.getItem(PERMIT2_PREFERENCE_STORAGE_KEY)).toBeNull()
  })

  it('leaves an existing signatures preference untouched', () => {
    storage = createStorage({
      [SIGNATURES_PREFERENCE_STORAGE_KEY]: 'true',
      [PERMIT2_PREFERENCE_STORAGE_KEY]: 'false',
    })

    seedSignaturePreference(storage)

    expect(storage.getItem(SIGNATURES_PREFERENCE_STORAGE_KEY)).toBe('true')
  })

  it('does nothing when neither key is set', () => {
    seedSignaturePreference(storage)

    expect(storage.snapshot()).toEqual({})
  })
})

describe('useSignaturePreference', () => {
  let isSafeWallet: Ref<boolean>
  let isSafeWalletResolved: Ref<boolean>

  const setupComposable = async () => {
    const { useSignaturePreference } = await import('~/composables/useSignaturePreference')
    return useSignaturePreference()
  }

  beforeEach(() => {
    vi.resetModules()
    isSafeWallet = ref(false)
    isSafeWalletResolved = ref(true)
    const state = new Map<string, Ref<unknown>>()
    vi.stubGlobal('useState', (key: string, init: () => unknown) => {
      let entry = state.get(key)
      if (!entry) {
        entry = ref(init())
        state.set(key, entry)
      }
      return entry
    })
    vi.stubGlobal('useLocalStorage', (_key: string, defaultValue: boolean) => ref(defaultValue))
    vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet, isSafeWalletResolved }))
  })

  it('follows the user preference for regular wallets', async () => {
    const { signaturesEnabled, signaturesForcedOff, setSignaturesEnabled } = await setupComposable()

    expect(signaturesEnabled.value).toBe(true)
    expect(signaturesForcedOff.value).toBe(false)

    setSignaturesEnabled(false)
    expect(signaturesEnabled.value).toBe(false)
  })

  it('forces signatures off while a Safe wallet is connected', async () => {
    isSafeWallet.value = true
    const { signaturesEnabled, signaturesForcedOff } = await setupComposable()

    expect(signaturesEnabled.value).toBe(false)
    expect(signaturesForcedOff.value).toBe(true)
  })

  it('preserves the stored preference across a Safe session', async () => {
    const { signaturesEnabled, setSignaturesEnabled } = await setupComposable()
    setSignaturesEnabled(true)

    isSafeWallet.value = true
    expect(signaturesEnabled.value).toBe(false)

    // Disconnecting the Safe restores the untouched user preference.
    isSafeWallet.value = false
    expect(signaturesEnabled.value).toBe(true)
  })

  it('fails closed while Safe detection is still pending', async () => {
    isSafeWalletResolved.value = false
    const { signaturesEnabled, signaturesForcedOff } = await setupComposable()

    // Unresolved detection must not allow a permit2-backed plan to prepare.
    expect(signaturesEnabled.value).toBe(false)
    expect(signaturesForcedOff.value).toBe(true)

    // Detection resolves to a regular wallet — preference applies again.
    isSafeWalletResolved.value = true
    expect(signaturesEnabled.value).toBe(true)
    expect(signaturesForcedOff.value).toBe(false)
  })

  it('ignores toggle writes while forced off without corrupting the preference', async () => {
    const { signaturesEnabled, setSignaturesEnabled } = await setupComposable()

    isSafeWallet.value = true
    // A stray write while forced off only changes the stored preference —
    // the effective value stays pinned to false.
    setSignaturesEnabled(true)
    expect(signaturesEnabled.value).toBe(false)

    isSafeWallet.value = false
    expect(signaturesEnabled.value).toBe(true)
  })
})
