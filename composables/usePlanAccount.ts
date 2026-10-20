import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { activeLayerAccountRef } from '~/composables/useTxBatch'
import { isPlanningAccountForContext } from '~/utils/planning-account-freshness'

/**
 * The account forms read for positions/shares and build plans against — the
 * single layer-aware source of truth: the active batch layer's stitched
 * (simulated) account when a layer is active, otherwise the fresh on-chain
 * account (`useFreshAccount`), falling back to the portfolio's account. Every
 * candidate must match the active wallet, chain and confirmation freshness.
 */
export const usePlanAccount = () => {
  const { account: freshAccount } = useFreshAccount()
  const { portfolio } = useEulerAccount()
  const { effectiveAddress } = useEffectiveAddress()
  const { chainId } = useEulerAddresses()

  const account = computed(() => [
    activeLayerAccountRef.value as Account<IHasVaultAddress> | undefined,
    freshAccount.value,
    portfolio.value?.account as Account<IHasVaultAddress> | undefined,
  ].find(candidate => isPlanningAccountForContext(candidate, effectiveAddress.value, chainId.value)))

  return { account }
}
