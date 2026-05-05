import type { Address } from 'viem'
import type { OperationsContext } from './types'
import { erc20BalanceOfAbi } from '~/abis/erc20'
import { logWarn } from '~/utils/errorHandling'

export const hasPreExistingVaultDeposit = async (
  ctx: OperationsContext,
  vaultAddress: Address,
  account: Address,
  logScope: string,
): Promise<boolean> => {
  try {
    const shares = await ctx.rpcProvider.readContract({
      address: vaultAddress,
      abi: erc20BalanceOfAbi,
      functionName: 'balanceOf',
      args: [account],
    }) as bigint

    return shares > 0n
  }
  catch (err) {
    logWarn(logScope, err)
    return true
  }
}
