import { useAccount, useWriteContract } from '@wagmi/vue'
import type { Address, Abi } from 'viem'
import { reulLockAbi, reulWithdrawABI } from '~/abis/reul'
import type { REULLock } from '~/entities/reul'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'
import { BATCH_SIZE_RPC_CALLS, POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'

const isLoaded = ref(false)
const isLocksLoading = ref(true)
const locks: Ref<REULLock[]> = ref([])

let interval: NodeJS.Timeout | null = null

export const useREULLocks = () => {
  const { isConnected, address: wagmiAddress, chainId } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const { eulerTokenAddresses } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  const reulTokenContractAddress = computed(() => eulerTokenAddresses.value?.rEUL ?? '')
  const eulTokenContractAddress = computed(() => eulerTokenAddresses.value?.EUL ?? '')
  const addressesReady = computed(() => !!reulTokenContractAddress.value && !!eulTokenContractAddress.value)

  const loadREULLocksInfo = async (userAddress: string, isInitialLoading = true) => {
    await until(addressesReady).toBeTruthy({ timeout: 10_000, throwOnTimeout: false })
    if (!addressesReady.value) {
      isLocksLoading.value = false
      return
    }

    try {
      if (!userAddress) {
        locks.value = []
        return
      }
      if (isInitialLoading) {
        isLocksLoading.value = true
      }

      const client = rpcClient.value!

      const [lockTimestamps, amounts] = await client.readContract({
        address: reulTokenContractAddress.value as Address,
        abi: reulLockAbi,
        functionName: 'getLockedAmounts',
        args: [userAddress as Address],
      }) as [bigint[], bigint[]]
      const withdrawAmountsData: { unlockableAmount: bigint, amountToBeBurned: bigint }[] = []

      const batchSize = BATCH_SIZE_RPC_CALLS

      for (let i = 0; i < lockTimestamps.length; i += batchSize) {
        const batch = lockTimestamps
          .slice(i, i + batchSize)
          .map(async (timestamp: bigint) => {
            const [unlockableAmount, amountToBeBurned] = await client.readContract({
              address: reulTokenContractAddress.value as Address,
              abi: reulLockAbi,
              functionName: 'getWithdrawAmountsByLockTimestamp',
              args: [userAddress as Address, timestamp],
            }) as [bigint, bigint]
            return {
              unlockableAmount,
              amountToBeBurned,
            }
          })

        withdrawAmountsData.push(...(await Promise.all(batch)))
      }

      locks.value = withdrawAmountsData.map((item, index) => ({
        timestamp: lockTimestamps[index],
        amount: amounts[index],
        unlockableAmount: item.unlockableAmount,
        amountToBeBurned: item.amountToBeBurned,
      }))
    }
    catch (e) {
      logWarn('reulLocks/fetch', e)
    }
    finally {
      isLocksLoading.value = false
    }
  }

  watch([isConnected, chainId], ([connected, currentChainId], [_oldConnected, oldChainId]) => {
    if (oldChainId && currentChainId !== oldChainId) {
      isLoaded.value = false
      locks.value = []
    }

    if (!isLoaded.value && wagmiAddress.value) {
      loadREULLocksInfo(wagmiAddress.value)
      isLoaded.value = true
    }

    if (connected && !interval) {
      interval = setInterval(() => {
        if (wagmiAddress.value) {
          loadREULLocksInfo(wagmiAddress.value, false)
        }
      }, POLL_INTERVAL_60S_MS)
    }
    else if (!connected) {
      locks.value = []
      isLocksLoading.value = false
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }
  }, { immediate: true })

  watch(wagmiAddress, (newAddress, oldAddress) => {
    if (oldAddress && newAddress && newAddress !== oldAddress) {
      isLoaded.value = false
      locks.value = []
      loadREULLocksInfo(newAddress)
      isLoaded.value = true
    }
  })

  onUnmounted(() => {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  })

  const unlockREUL = async (lockTimestamps: bigint[]) => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    if (!reulTokenContractAddress.value) {
      throw new Error('REUL contract address not available')
    }

    const hash = await writeContractAsync({
      address: reulTokenContractAddress.value as Address,
      abi: reulWithdrawABI,
      functionName: 'withdrawToByLockTimestamp',
      args: [wagmiAddress.value, lockTimestamps[0] as bigint, true],
    })

    const receipt = await rpcClient.value!.waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') {
      throw new Error('Transaction reverted')
    }

    return hash
  }

  const buildUnlockREULPlan = async (lockTimestamps: bigint[]): Promise<TxPlan> => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }

    if (!reulTokenContractAddress.value) {
      throw new Error('REUL contract address not available')
    }

    return {
      kind: 'reul-unlock',
      steps: [
        {
          type: 'other',
          label: 'Unlock rEUL',
          to: reulTokenContractAddress.value as Address,
          abi: reulWithdrawABI as Abi,
          functionName: 'withdrawToByLockTimestamp',
          args: [wagmiAddress.value, lockTimestamps[0] as bigint, true] as const,
          value: 0n,
        },
      ],
    }
  }

  return {
    locks,
    isLocksLoading,
    reulTokenContractAddress,
    eulTokenContractAddress,
    loadREULLocksInfo: (address: string, isInitial?: boolean) => loadREULLocksInfo(address, isInitial),
    unlockREUL,
    buildUnlockREULPlan,
  }
}
