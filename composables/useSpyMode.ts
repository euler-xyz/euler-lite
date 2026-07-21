import { isAddress, getAddress } from 'viem'
import { truncate } from '~/utils/string-utils'
import { logWarn } from '~/utils/errorHandling'
import { evcGetAccountOwnerAbi } from '~/abis/evc'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const OWNER_RESOLUTION_RETRY_DELAY_MS = 4_000
const OWNER_RESOLUTION_MAX_RETRIES = 5

/** viem's isAddress validates EIP-55 checksum on mixed-case input — normalize to lowercase first */
const isValidAddress = (value: string): boolean =>
  typeof value === 'string' && isAddress(value.toLowerCase() as `0x${string}`)

const normalizeAddress = (value: string): string =>
  getAddress(value.toLowerCase() as `0x${string}`)

/** Owner-verified address — the only value consumers may query or display. */
const spyAddress = ref('')
/** Unverified candidate awaiting EVC owner resolution. Never consumed. */
const pendingSpyAddress = ref('')
let watchersInitialized = false
let explicitlyCleared = false
let ownerResolutionRequestId = 0

/** Lightweight accessor for middleware — avoids useRoute() */
export const getSpyModeState = () => ({
  spyAddress: computed(() => spyAddress.value),
  /** Value to persist in the URL: the verified address, or the user-supplied
   *  candidate while resolution is still pending. Never render this. */
  spyQueryValue: computed(() => spyAddress.value || pendingSpyAddress.value),
  isSpyMode: computed(() => Boolean(spyAddress.value || pendingSpyAddress.value)),
})

export const useSpyMode = () => {
  const route = useRoute()
  const router = useRouter()

  const isSpyMode = computed(() => Boolean(spyAddress.value || pendingSpyAddress.value))
  const isSpyResolving = computed(() => Boolean(pendingSpyAddress.value))
  const spyShortAddress = computed(() => spyAddress.value ? truncate(spyAddress.value) : '')

  const activateSpyMode = (address: string): boolean => {
    if (!isValidAddress(address)) return false
    explicitlyCleared = false
    const normalized = normalizeAddress(address)
    // Already verified — re-verification would only blank the UI.
    if (normalized === spyAddress.value && !pendingSpyAddress.value) return true
    // Fail closed: the candidate stays out of `spyAddress` (and therefore out
    // of every query and display surface) until the EVC confirms its owner.
    pendingSpyAddress.value = normalized
    spyAddress.value = ''
    ownerResolutionRequestId += 1
    return true
  }

  // Try to pick up ?spy= — route.query may not be populated yet, so read from window.location
  if (!spyAddress.value && !explicitlyCleared && typeof window !== 'undefined') {
    const spy = new URLSearchParams(window.location.search).get('spy')
      || (route.query.spy as string | undefined)
    if (spy && isValidAddress(spy)) {
      activateSpyMode(spy)
    }
  }

  if (!watchersInitialized && typeof window !== 'undefined') {
    watchersInitialized = true

    const { eulerCoreAddresses, chainId } = useEulerAddresses()
    const { client: rpcClient } = useRpcClient()

    /** `null` = the lookup could not run or failed — NOT an answer. */
    const resolveOwner = async (address: string): Promise<string | null> => {
      try {
        const evcAddress = eulerCoreAddresses.value?.evc
        if (!evcAddress || !chainId.value || !rpcClient.value) return null

        const owner = await rpcClient.value.readContract({
          address: evcAddress as `0x${string}`,
          abi: evcGetAccountOwnerAbi,
          functionName: 'getAccountOwner',
          authorizationList: undefined,
          args: [address as `0x${string}`],
        })

        if (owner && owner !== ZERO_ADDRESS && getAddress(owner) !== getAddress(address)) {
          return getAddress(owner)
        }
        // Authoritative answer: the address is its own owner (or was never
        // EVC-registered, in which case it cannot be a sub-account).
        return address
      }
      catch (err) {
        logWarn('useSpyMode/resolveOwner', err)
        return null
      }
    }

    const applyResolved = (
      sourceAddress: string,
      resolved: string | null,
      requestId: number,
      attempt = 0,
    ) => {
      if (requestId !== ownerResolutionRequestId || pendingSpyAddress.value !== sourceAddress) return

      if (resolved === null) {
        // Fail closed: a failed lookup never counts as resolution — the
        // candidate stays pending (unconsumed, undisplayed). Retry while this
        // spy session is still active.
        if (attempt < OWNER_RESOLUTION_MAX_RETRIES) {
          setTimeout(() => {
            if (requestId !== ownerResolutionRequestId || pendingSpyAddress.value !== sourceAddress) return
            resolveOwner(sourceAddress).then(nextResolved =>
              applyResolved(sourceAddress, nextResolved, requestId, attempt + 1))
          }, OWNER_RESOLUTION_RETRY_DELAY_MS)
        }
        return
      }

      pendingSpyAddress.value = ''
      spyAddress.value = resolved
      if (resolved !== sourceAddress || route.query.spy !== resolved) {
        router.replace({
          path: route.path,
          query: { ...route.query, spy: resolved },
          hash: route.hash,
        })
      }
    }

    // Watch route query to pick up ?spy= on initial load and navigation
    watch(
      () => route.query.spy,
      (spy) => {
        if (!spy || typeof spy !== 'string' || !isValidAddress(spy)) return
        const nextAddress = normalizeAddress(spy)
        if (nextAddress !== spyAddress.value && nextAddress !== pendingSpyAddress.value) {
          activateSpyMode(nextAddress)
        }
      },
      { immediate: true },
    )

    // Resolve the pending candidate once the EVC and RPC client are both
    // available — resolution is the only path that promotes a candidate into
    // the consumable spyAddress.
    watch(
      [() => pendingSpyAddress.value, () => eulerCoreAddresses.value?.evc, rpcClient],
      ([candidate, evc, client]) => {
        if (candidate && evc && client) {
          const requestId = ++ownerResolutionRequestId
          resolveOwner(candidate).then(resolved => applyResolved(candidate, resolved, requestId))
        }
      },
      { immediate: true },
    )
  }

  const setSpyMode = async (address: string) => {
    if (!activateSpyMode(address)) return

    await router.replace({
      path: route.path,
      // The candidate is what was just activated; the verified address only
      // exists when activation short-circuited on an already-verified value.
      query: { ...route.query, spy: pendingSpyAddress.value || spyAddress.value },
      hash: route.hash,
    })
  }

  const clearSpyMode = async () => {
    explicitlyCleared = true
    spyAddress.value = ''
    pendingSpyAddress.value = ''
    ownerResolutionRequestId += 1
    const { spy: _spy, ...rest } = route.query
    await router.replace({
      path: route.path,
      query: rest,
      hash: route.hash,
    })
  }

  return {
    spyAddress: computed(() => spyAddress.value),
    isSpyMode,
    isSpyResolving,
    spyShortAddress,
    activateSpyMode,
    setSpyMode,
    clearSpyMode,
  }
}
