import { getAddress, type Address } from 'viem'
import type { IProviderService } from '@eulerxyz/euler-v2-sdk'
import type { OperationIntent } from '../domain/intents'
import { evcAccountExposureAbi } from '~/abis/evc'
import { vaultDebtOfAbi } from '~/abis/vault'
import { ADDRESS_EXIT_ONLY_MESSAGE, isAddressExitOnly } from '~/composables/addressExitOnlyState'

export interface WithdrawalPolicyContext {
  provider: Pick<ReturnType<IProviderService['getProvider']>, 'getBlockNumber' | 'readContract'>
  evcAddress: Address
}

/** Read current exposure outside the SDK account/query cache and cart projections. */
export const assertExitOnlyWithdrawals = async (
  intents: readonly OperationIntent[],
  context?: WithdrawalPolicyContext,
): Promise<void> => {
  if (!isAddressExitOnly.value) return
  const withdrawals = intents.filter(intent => intent.planner.name === 'withdraw' || intent.planner.name === 'redeem')
  if (!withdrawals.length) return
  if (!context) throw new Error('Current collateral debt is unavailable. Please retry.')

  const byAccount = new Map<Address, Set<Address>>()
  for (const intent of withdrawals) {
    const account = getAddress(intent.planner.args.owner as Address)
    const vaults = byAccount.get(account) ?? new Set<Address>()
    vaults.add(getAddress(intent.planner.args.vaultAddress as Address))
    byAccount.set(account, vaults)
  }

  // Pin every exposure/debt read to one latest block; never reuse a cached block number.
  const { provider, evcAddress } = context
  const blockNumber = await provider.getBlockNumber({ cacheTime: 0 })
  await Promise.all([...byAccount].map(async ([account, vaults]) => {
    const collaterals = await provider.readContract({
      address: evcAddress, abi: evcAccountExposureAbi, functionName: 'getCollaterals', args: [account], blockNumber, authorizationList: undefined,
    })
    if (!collaterals.some(vault => vaults.has(getAddress(vault)))) return
    const controllers = await provider.readContract({
      address: evcAddress, abi: evcAccountExposureAbi, functionName: 'getControllers', args: [account], blockNumber, authorizationList: undefined,
    })
    const debts = await Promise.all(controllers.map(controller => provider.readContract({
      address: controller, abi: vaultDebtOfAbi, functionName: 'debtOf', args: [account], blockNumber, authorizationList: undefined,
    })))
    if (debts.some(debt => debt > 0n)) throw new Error(ADDRESS_EXIT_ONLY_MESSAGE)
  }))
}
