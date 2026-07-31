import { beforeEach, describe, expect, it } from 'vitest'

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
