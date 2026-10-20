import { computed, ref, shallowRef, watch, type Ref } from 'vue'
import { getAddress, type Address } from 'viem'
import type { Account, AccountFetchOptions, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkForChain, getEulerSdkFresh } from '~/composables/useEulerSdk'
import { setBatchPrefetchedPlanningAccount } from '~/composables/batchPrefetchState'
import { logWarn } from '~/utils/errorHandling'
import { isPlanningAccountCurrent, readFreshPlanningAccount } from '~/utils/planning-account-freshness'

/**
 * Account-fetch options sized for plan-time consumers:
 * - `populateVaults: true` so the Pyth plugin's `resolveAccount` short-circuits
 *   on `account.populated.vaults` and skips its own fetchAccount round-trip.
 * - Vault metadata is populated with the SDK defaults; labels, intrinsic APY,
 *   rewards, and market prices are display-side concerns the planners don't need.
 */
const PLAN_ACCOUNT_FETCH_OPTIONS: AccountFetchOptions = {
  populateVaults: true,
  populateMarketPrices: false,
  populateUserRewards: false,
}

/**
 * Shared planning snapshot: controllers, sub-account positions and vault state
 * for share/asset conversion. Confirmations invalidate its planning eligibility
 * synchronously; only a subsequent checked on-chain read can restore it.
 * Allowances, Pyth update data and simulation use the SDK's query cache.
 */
const account = shallowRef<Account<IHasVaultAddress> | undefined>()
const isLoading = ref(false)

type Freshness = 'none' | 'fast' | 'fresh'

// Per-load cursor: scopes the race-replace logic to one in-flight pair so
// stale results from a previous load (e.g. wallet swap mid-flight) can't
// clobber the current one.
let loadCursor = 0
const freshnessByCursor = new Map<number, Freshness>()

const apply = (
  cursor: number,
  which: Exclude<Freshness, 'none'>,
  result: Account<IHasVaultAddress>,
) => {
  if (cursor !== loadCursor || !isPlanningAccountCurrent(result)) return
  const current = freshnessByCursor.get(cursor) ?? 'none'
  // Priority: fresh always replaces; fast only fills 'none'.
  if (which === 'fresh' || current === 'none') {
    account.value = result
    setBatchPrefetchedPlanningAccount(result)
    freshnessByCursor.set(cursor, which)
  }
}

const load = async (owner: Address, chainId: number) => {
  const cursor = ++loadCursor
  freshnessByCursor.set(cursor, 'none')
  isLoading.value = true

  const fastTask = (async () => {
    try {
      const sdk = await getEulerSdkForChain(chainId)
      const { result } = await sdk.accountService.fetchAccount(chainId, owner, PLAN_ACCOUNT_FETCH_OPTIONS)
      apply(cursor, 'fast', result as Account<IHasVaultAddress>)
    }
    catch (err) {
      logWarn('useFreshAccount/fast', err)
    }
  })()

  const freshTask = (async () => {
    try {
      const result = await readFreshPlanningAccount(chainId, async () => {
        const sdk = await getEulerSdkFresh()
        const fetched = await sdk.accountService.fetchAccount(chainId, owner, PLAN_ACCOUNT_FETCH_OPTIONS)
        return fetched.result
      })
      apply(cursor, 'fresh', result)
    }
    catch (err) {
      logWarn('useFreshAccount/fresh', err)
    }
  })()

  await Promise.allSettled([fastTask, freshTask])
  if (cursor === loadCursor) {
    isLoading.value = false
  }
  freshnessByCursor.delete(cursor)
}

const reset = () => {
  loadCursor++ // invalidate any in-flight applies
  account.value = undefined
  setBatchPrefetchedPlanningAccount(undefined)
  isLoading.value = false
}

/**
 * Race-replace fresh-account loader.
 *
 * Fires both fast (V3 fallback) and fresh (always on-chain) `fetchAccount`
 * calls in parallel on wallet/chain/refresh-trigger changes. Before a chain's
 * first confirmation, fast can fill the ref and fresh replaces it. After a
 * confirmation, only fresh reads after indexer catch-up are eligible; a failed
 * refresh cannot expose a V3, portfolio or earlier planning snapshot.
 *
 * Pages that need the plan-time Account entity should consume `account` and
 * pass it into `useEulerTx` planners — that bypasses the per-click
 * `fetchAccount` round-trip that the planners would otherwise do via
 * `freshPlanContext`.
 */
export const useFreshAccount = () => {
  const { effectiveAddress } = useEffectiveAddress()
  const { chainId } = useEulerAddresses()
  const { portfolioRefreshCounter } = usePortfolioRefresh()

  const effectiveOwner = computed<Address | undefined>(() => {
    const raw = effectiveAddress.value
    if (!raw) return undefined
    try {
      return getAddress(raw as string)
    }
    catch {
      return undefined
    }
  })

  const triggerLoad = () => {
    const owner = effectiveOwner.value
    const cid = chainId.value
    if (!owner || !cid) {
      reset()
      return
    }
    void load(owner, cid)
  }

  watch([effectiveOwner, chainId], triggerLoad, { immediate: true })

  // Post-tx and other portfolio-wide refresh triggers.
  watch(portfolioRefreshCounter, () => {
    if (effectiveOwner.value && chainId.value) triggerLoad()
  })

  const refresh = () => {
    triggerLoad()
  }

  return {
    account: computed(() => isPlanningAccountCurrent(account.value) ? account.value : undefined) as Readonly<Ref<Account<IHasVaultAddress> | undefined>>,
    isLoading,
    refresh,
  }
}
