import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

export const usePlanAccount = () => {
  const { account: freshAccount } = useFreshAccount()
  const { portfolio } = useEulerAccount()

  const account = computed(() =>
    freshAccount.value ?? (portfolio.value?.account as Account<IHasVaultAddress> | undefined),
  )

  return { account }
}
