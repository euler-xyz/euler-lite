import { PERMIT2_PREFERENCE_STORAGE_KEY, SIGNATURES_PREFERENCE_STORAGE_KEY } from '~/entities/constants'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * Carry the legacy permit2 preference over to the generalized signatures key.
 *
 * The setting used to control permit2 only, because permit2 messages were the
 * only signatures collected. It now covers every message signature in the app,
 * so users who opted out of permit2 must stay opted out of signatures.
 *
 * Removing the legacy key makes this naturally one-time.
 */
export const seedSignaturePreference = (storage: StorageLike) => {
  if (storage.getItem(SIGNATURES_PREFERENCE_STORAGE_KEY) !== null) return
  const legacy = storage.getItem(PERMIT2_PREFERENCE_STORAGE_KEY)
  if (legacy === null) return
  // Raw copy: both keys use the same VueUse boolean serializer ('true'/'false').
  storage.setItem(SIGNATURES_PREFERENCE_STORAGE_KEY, legacy)
  storage.removeItem(PERMIT2_PREFERENCE_STORAGE_KEY)
}

export const useSignaturePreference = () => {
  if (import.meta.client) {
    // Must run before useLocalStorage first reads the key below.
    try {
      seedSignaturePreference(localStorage)
    }
    catch {
      // Storage unavailable (private mode); fall back to the default.
    }
  }

  const userPreference = useState<boolean>(SIGNATURES_PREFERENCE_STORAGE_KEY, () => true)
  const persisted = useLocalStorage<boolean>(SIGNATURES_PREFERENCE_STORAGE_KEY, true)

  const syncValue = (value: boolean) => {
    if (userPreference.value !== value) {
      userPreference.value = value
    }
    if (persisted.value !== value) {
      persisted.value = value
    }
  }

  watch(persisted, value => syncValue(value), { immediate: true })
  watch(userPreference, value => syncValue(value))

  const setSignaturesEnabled = (value: boolean) => {
    syncValue(value)
  }

  // Safe multisigs execute approvals inside the batched Safe transaction and
  // off-chain signatures are a poor fit (EIP-1271 collection per signer, plus
  // a one-time on-chain approval to Permit2 anyway) — force the approval
  // flow while a Safe is connected. The stored preference is untouched, so
  // it comes back when the user reconnects a regular wallet.
  const { isSafeWallet } = useSafeWallet()
  const signaturesForcedOff = isSafeWallet

  const signaturesEnabled = computed(() => userPreference.value && !signaturesForcedOff.value)

  return {
    signaturesEnabled,
    signaturesForcedOff,
    setSignaturesEnabled,
  }
}
