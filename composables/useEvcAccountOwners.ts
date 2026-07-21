import { getAddress, isAddress, type Address } from 'viem'
import { computed, reactive } from 'vue'
import { evcGetAccountOwnerAbi } from '~/abis/evc'
import { logWarn } from '~/utils/errorHandling'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const RETRY_DELAY_MS = 5_000
const MAX_ATTEMPTS = 3

/**
 * Chain-scoped EVC account-owner cache.
 *
 * Sub-account addresses must never be displayed in the app — funds sent to
 * one are unrecoverable — and vault-scope activity events carry no owner
 * metadata, so resolving through the EVC is the only reliable way to tell a
 * wallet apart from a sub-account.
 *
 * Cache semantics: no entry = unknown/pending (keep the address hidden),
 * `null` = resolved as safe to display as-is (the address is its own owner or
 * was never EVC-registered), `Address` = registered owner to display instead.
 */
const owners = reactive(new Map<string, Address | null>())
const pending = new Set<string>()
const attempts = new Map<string, number>()

const cacheKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

export const useEvcAccountOwners = () => {
  const { eulerCoreAddresses, chainId: activeChainId } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  /**
   * Callers should include this in the watch that issues `requestOwner` calls:
   * requests made before the EVC address and RPC client are available are
   * dropped, and only re-firing on readiness picks them back up.
   */
  const resolverReady = computed(() =>
    Boolean(eulerCoreAddresses.value?.evc && rpcClient.value))

  const requestOwner = (chainId: number, address: string) => {
    const normalized = address.toLowerCase() as `0x${string}`
    if (!isAddress(normalized)) return
    const key = cacheKey(chainId, address)
    if (owners.has(key) || pending.has(key)) return
    if ((attempts.get(key) ?? 0) >= MAX_ATTEMPTS) return

    const evcAddress = eulerCoreAddresses.value?.evc
    const client = rpcClient.value
    if (!evcAddress || !client || Number(activeChainId.value) !== chainId) return

    pending.add(key)
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
    client.readContract({
      address: evcAddress as Address,
      abi: evcGetAccountOwnerAbi,
      functionName: 'getAccountOwner',
      authorizationList: undefined,
      args: [getAddress(normalized)],
    })
      .then((owner) => {
        owners.set(
          key,
          owner && owner !== ZERO_ADDRESS && getAddress(owner) !== getAddress(normalized)
            ? getAddress(owner)
            : null,
        )
      })
      .catch((err) => {
        // Fail closed: the address stays hidden. Retry a bounded number of
        // times — nothing else re-triggers a request for the same address.
        logWarn('useEvcAccountOwners/requestOwner', err)
        if ((attempts.get(key) ?? 0) < MAX_ATTEMPTS) {
          setTimeout(() => requestOwner(chainId, address), RETRY_DELAY_MS)
        }
      })
      .finally(() => pending.delete(key))
  }

  /**
   * `undefined` = still resolving (hide the address), `null` = safe to show
   * as-is, `Address` = show this owner wallet instead.
   */
  const getResolvedOwner = (chainId: number, address: string): Address | null | undefined =>
    owners.get(cacheKey(chainId, address))

  return { requestOwner, getResolvedOwner, resolverReady }
}
