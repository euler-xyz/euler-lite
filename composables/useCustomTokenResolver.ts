import type { VaultAsset } from '~/types/asset'
import { isAddress, type Address } from 'viem'
import { erc20DecimalsAbi } from '~/abis/erc20'
import { readErc20StringField } from '~/utils/erc20-metadata'

import { createRaceGuard } from '~/utils/race-guard'

export const useCustomTokenResolver = () => {
  const { client: rpcClient } = useRpcClient()
  const { fetchSingleBalance } = useWallets()

  const customToken = ref<VaultAsset | null>(null)
  const customTokenBalance = ref<bigint>(0n)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const guard = createRaceGuard()

  const resolve = async (input: string) => {
    reset()

    if (!isAddress(input)) return

    const gen = guard.next()
    isLoading.value = true

    const address = input as Address

    try {
      const [symbolResult, decimalsResult, nameResult, balance] = await Promise.all([
        // name()/symbol() may be bytes32 on legacy tokens (e.g. MKR), so read via
        // the string→bytes32 fallback helper rather than a string-only ABI.
        readErc20StringField(rpcClient.value!, address, 'symbol'),
        rpcClient.value!.readContract({
          address,
          abi: erc20DecimalsAbi,
          functionName: 'decimals',
          authorizationList: undefined,
        }).catch(() => null),
        readErc20StringField(rpcClient.value!, address, 'name'),
        fetchSingleBalance(input).catch(() => 0n),
      ])

      if (guard.isStale(gen)) return

      if (symbolResult == null || decimalsResult == null) {
        error.value = 'Not a valid ERC-20 token'
        return
      }

      const symbol = symbolResult
      const decimals = decimalsResult as number
      const name = nameResult || symbol

      customToken.value = { address: input, symbol, decimals, name }
      customTokenBalance.value = balance
    }
    catch {
      if (guard.isStale(gen)) return
      error.value = 'Not a valid ERC-20 token'
    }
    finally {
      if (!guard.isStale(gen)) {
        isLoading.value = false
      }
    }
  }

  const reset = () => {
    customToken.value = null
    customTokenBalance.value = 0n
    isLoading.value = false
    error.value = null
  }

  return {
    customToken,
    customTokenBalance,
    isLoading,
    error,
    resolve,
    reset,
  }
}
