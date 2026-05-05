import { isAddress, type Address } from 'viem'
import { erc20SymbolAbi, erc20DecimalsAbi, erc20NameAbi } from '~/abis/erc20'
import type { VaultAsset } from '~/entities/vault'
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
        rpcClient.value!.readContract({
          address,
          abi: erc20SymbolAbi,
          functionName: 'symbol',
        }).catch(() => null),
        rpcClient.value!.readContract({
          address,
          abi: erc20DecimalsAbi,
          functionName: 'decimals',
        }).catch(() => null),
        rpcClient.value!.readContract({
          address,
          abi: erc20NameAbi,
          functionName: 'name',
        }).catch(() => null),
        fetchSingleBalance(input).catch(() => 0n),
      ])

      if (guard.isStale(gen)) return

      if (symbolResult == null || decimalsResult == null) {
        error.value = 'Not a valid ERC-20 token'
        return
      }

      const symbol = symbolResult as string
      const decimals = decimalsResult as number
      const name = (nameResult as string) || symbol

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
