import { computed } from 'vue'

/**
 * Wallet-level CoW Swap eligibility.
 *
 * CoW orders require a recoverable ECDSA signature — the SDK's cowExecutor
 * rejects anything else (`normalizeCowSignature`), and it does so only
 * AFTER the user has already sent ERC-20 approval transactions. Safe
 * multisigs cannot produce such a signature, so CoW is removed from their
 * quote pipeline entirely and they route to on-chain swap providers.
 *
 * Fail closed while Safe detection for the current connector is pending —
 * guessing wrong costs the user stranded approvals (and, on close-position
 * flows, a burned EVC permit nonce).
 */
export const useCowSwapEligibility = () => {
  const { isSafeWallet, isSafeWalletResolved } = useSafeWallet()

  const cowSwapForcedOff = computed(() => isSafeWallet.value || !isSafeWalletResolved.value)

  return { cowSwapForcedOff }
}
