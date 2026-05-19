import { getAddress, type Address } from 'viem'
import { getFreeSubAccounts } from '@eulerxyz/euler-v2-sdk'

// When `borrowVault` is provided, prefer a sub-account whose existing
// controller set is compatible with opening a borrow position in that vault
// (i.e. no conflicting controller). Used by CoW open-position flows because
// they cannot fall back to enabling a new controller mid-batch.
export const getNewSubAccount = async (ownerAddress: string, borrowVault?: Address | string) => {
  const { portfolio } = useEulerAccount()
  const borrowVaultAddress = borrowVault ? getAddress(borrowVault) : undefined
  if (portfolio.value) {
    const subAccount = portfolio.value.getNewSubAccount(
      borrowVaultAddress ? { borrowVault: borrowVaultAddress } : undefined,
    )
    if (subAccount) return subAccount
    throw new Error('Free subaccount not found')
  }

  const [subAccount] = getFreeSubAccounts(getAddress(ownerAddress), [])
  if (subAccount) return subAccount

  throw new Error('Free subaccount not found')
}
