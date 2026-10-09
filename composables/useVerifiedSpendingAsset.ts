import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { getAddress, zeroAddress } from 'viem'
import type { VaultAsset } from '~/types/asset'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'

/** Only selected spending tokens are verified; lists and output pickers stay read-free.
 * The writable ref accepts candidates but exposes only the verified local copy.
 */
export const useVerifiedSpendingAsset = (invalidate?: () => void) => {
  const { chainId } = useEulerAddresses()
  const requested = shallowRef<VaultAsset>()
  const verified = shallowRef<VaultAsset>()
  let defaultKey: string | undefined
  let defaultAddress: string | undefined
  const error = ref<string | null>(null)
  const isLoading = ref(false)
  let generation = 0

  const resolve = async () => {
    const current = ++generation
    const candidate = requested.value
    const chain = chainId.value
    verified.value = undefined
    error.value = null
    isLoading.value = false
    invalidate?.()
    if (!candidate) return
    try {
      const address = getAddress(candidate.address.toLowerCase())
      if (!chain) throw new Error('No selected chain')
      if (address === zeroAddress) {
        verified.value = { ...candidate }
        return
      }
      isLoading.value = true
      const sdk = await getEulerSdkForChain(chain)
      if (!sdk.tokenlistService.resolveTokenDecimals) throw new Error('Token decimals resolver unavailable')
      const decimals = await sdk.tokenlistService.resolveTokenDecimals(chain, address)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals')
      if (current === generation) verified.value = { ...candidate, decimals }
    }
    catch {
      if (current === generation) error.value = 'Unable to verify token decimals. Retry to continue.'
    }
    finally {
      if (current === generation) isLoading.value = false
    }
  }
  watch(chainId, () => {
    // A selected address and its label belong to the previous chain.
    requested.value = undefined
    defaultKey = undefined
    defaultAddress = undefined
    void resolve()
  }, { flush: 'sync' })
  if (getCurrentScope()) {
    onScopeDispose(() => {
      generation++
    })
  }

  const asset = computed({
    get: () => verified.value,
    set: (candidate: VaultAsset | undefined) => {
      requested.value = candidate ? { ...candidate } : undefined
      void resolve()
    },
  })
  // The vault asset is also a wallet spending token on direct paths. Seed it
  // without replacing an explicit pay-with selection on later vault refreshes.
  const setDefaultAsset = (candidate?: VaultAsset) => {
    const nextKey = candidate && chainId.value ? `${chainId.value}:${candidate.address.toLowerCase()}` : undefined
    if (nextKey === defaultKey) return
    const useDefault = !requested.value || requested.value.address.toLowerCase() === defaultAddress
    defaultKey = nextKey
    defaultAddress = candidate?.address.toLowerCase()
    if (useDefault) asset.value = candidate
  }
  const isBlocked = computed(() => !!requested.value && !verified.value)
  return { asset, isBlocked, isLoading, error, retry: resolve, setDefaultAsset }
}
