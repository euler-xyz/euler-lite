import { getAddress, type Address } from 'viem'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'

const SUB_ACCOUNT_SNAPSHOT_FETCH_OPTIONS = {
  populateVaults: false,
  populateMarketPrices: false,
  populateUserRewards: false,
} as const

// When `borrowVault` is provided, prefer a sub-account whose existing
// controller set is compatible with opening a borrow position in that vault
// (i.e. no conflicting controller). Used by CoW open-position flows because
// they cannot fall back to enabling a new controller mid-batch.
export const getNewSubAccount = async (ownerAddress: string, borrowVault?: Address | string) => {
  const { portfolio } = useEulerAccount()
  const { chainId } = useEulerAddresses()
  if (!chainId.value) throw new Error('Free subaccount not found')

  const sdk = await getEulerSdkFresh()
  const owner = getAddress(ownerAddress)
  const borrowVaultAddress = borrowVault ? getAddress(borrowVault) : undefined
  const resolved = await sdk.accountService.resolveNewSubAccount(chainId.value, owner, {
    account: portfolio.value?.account,
    borrowVault: borrowVaultAddress,
    fetchOptions: SUB_ACCOUNT_SNAPSHOT_FETCH_OPTIONS,
  })

  if (resolved.result) return resolved.result

  throw new Error(borrowVaultAddress ? 'Compatible free subaccount not found' : 'Free subaccount not found')
}
