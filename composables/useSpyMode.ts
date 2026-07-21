import { isAddress, getAddress } from 'viem'
import { truncate } from '~/utils/string-utils'
import { logWarn } from '~/utils/errorHandling'
import { evcGetAccountOwnerAbi } from '~/abis/evc'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** viem's isAddress validates EIP-55 checksum on mixed-case input — normalize to lowercase first */
const isValidAddress = (value: string): boolean =>
  typeof value === 'string' && isAddress(value.toLowerCase() as `0x${string}`)

const normalizeAddress = (value: string): string =>
  getAddress(value.toLowerCase() as `0x${string}`)

const spyAddress = ref('')
let watchersInitialized = false
let ownerResolved = false
let explicitlyCleared = false
let ownerResolutionRequestId = 0

/** Lightweight accessor for middleware — avoids useRoute() */
export const getSpyModeState = () => ({
  spyAddress: computed(() => spyAddress.value),
  isSpyMode: computed(() => Boolean(spyAddress.value)),
})

export const useSpyMode = () => {
  const route = useRoute()
  const router = useRouter()

  const isSpyMode = computed(() => Boolean(spyAddress.value))
  const spyShortAddress = computed(() => spyAddress.value ? truncate(spyAddress.value) : '')

  const activateSpyMode = (address: string): boolean => {
    if (!isValidAddress(address)) return false
    explicitlyCleared = false
    spyAddress.value = normalizeAddress(address)
    ownerResolved = false
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

    const resolveOwner = async (address: string): Promise<string> => {
      try {
        const evcAddress = eulerCoreAddresses.value?.evc
        if (!evcAddress || !chainId.value || !rpcClient.value) return address

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
      }
      catch (err) {
        logWarn('useSpyMode/resolveOwner', err)
      }
      return address
    }

    const applyResolved = (sourceAddress: string, resolved: string, requestId: number) => {
      if (requestId !== ownerResolutionRequestId || spyAddress.value !== sourceAddress) return

      if (resolved !== spyAddress.value) {
        spyAddress.value = resolved
        router.replace({
          path: route.path,
          query: { ...route.query, spy: resolved },
          hash: route.hash,
        })
      }
      ownerResolved = true
    }

    // Watch route query to pick up ?spy= on initial load and navigation
    watch(
      () => route.query.spy,
      (spy) => {
        if (!spy || typeof spy !== 'string' || !isValidAddress(spy)) return
        const nextAddress = normalizeAddress(spy)
        if (nextAddress !== spyAddress.value) activateSpyMode(nextAddress)
      },
      { immediate: true },
    )

    // Resolve owner once the spy address, EVC, and RPC client are all
    // available — resolving without a client would silently accept a
    // sub-account as the inspected owner.
    watch(
      [() => spyAddress.value, () => eulerCoreAddresses.value?.evc, rpcClient],
      ([addr, evc, client]) => {
        if (addr && evc && client && !ownerResolved) {
          const requestId = ++ownerResolutionRequestId
          resolveOwner(addr).then(resolved => applyResolved(addr, resolved, requestId))
        }
      },
      { immediate: true },
    )
  }

  const setSpyMode = async (address: string) => {
    if (!activateSpyMode(address)) return

    await router.replace({
      path: route.path,
      query: { ...route.query, spy: spyAddress.value },
      hash: route.hash,
    })
  }

  const clearSpyMode = async () => {
    explicitlyCleared = true
    spyAddress.value = ''
    ownerResolved = false
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
    spyShortAddress,
    activateSpyMode,
    setSpyMode,
    clearSpyMode,
  }
}
