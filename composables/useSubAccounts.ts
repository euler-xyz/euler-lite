import { getAddress } from 'viem'
import { getFreeSubAccounts } from '@eulerxyz/euler-v2-sdk'

export const getNewSubAccount = async (ownerAddress: string) => {
  const { portfolio } = useEulerAccount()
  if (portfolio.value) {
    const subAccount = portfolio.value.getNewSubAccount()
    if (subAccount) return subAccount
    throw new Error('Free subaccount not found')
  }

  const [subAccount] = getFreeSubAccounts(getAddress(ownerAddress), [])
  if (subAccount) return subAccount

  throw new Error('Free subaccount not found')
}
