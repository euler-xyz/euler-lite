/**
 * Resolves the address the UI should act on: the spied-on address when spy mode
 * is active, otherwise the connected wallet address.
 *
 * Centralizes the `isSpyMode ? spyAddress : address` pattern that was previously
 * duplicated across borrow/repay/lend/earn forms and pages. Re-exports the
 * underlying `useWagmi`/`useSpyMode` values so callers keep a single destructure.
 */
export const useEffectiveAddress = () => {
  const { address, isConnected } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()

  const effectiveAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)

  return {
    address,
    isConnected,
    isSpyMode,
    spyAddress,
    effectiveAddress,
  }
}
