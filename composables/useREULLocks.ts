import { useAccount } from '@wagmi/vue'
import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { REULLock } from '~/entities/reul'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'

const isLoaded = ref(false)
const isLocksLoading = ref(true)
const locks: Ref<REULLock[]> = ref([])

let interval: NodeJS.Timeout | null = null

export const useREULLocks = () => {
  const { isConnected, address: wagmiAddress, chainId } = useAccount()
  const { eulerTokenAddresses } = useEulerAddresses()
  const { spyAddress } = useSpyMode()

  const effectiveAddress = computed(() => spyAddress.value || wagmiAddress.value || '')
  const isActive = computed(() => isConnected.value || Boolean(spyAddress.value))

  const reulTokenContractAddress = computed(() => eulerTokenAddresses.value?.rEUL ?? '')
  const eulTokenContractAddress = computed(() => eulerTokenAddresses.value?.EUL ?? '')
  const addressesReady = computed(() => !!reulTokenContractAddress.value && !!eulTokenContractAddress.value)

  const loadREULLocksInfo = async (userAddress: string, isInitialLoading = true) => {
    await until(addressesReady).toBeTruthy({ timeout: 10_000, throwOnTimeout: false })
    if (!addressesReady.value || !chainId.value) {
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

      const sdk = await getEulerSdk()
      locks.value = await sdk.reulLockService.fetchLocks({
        chainId: chainId.value,
        account: userAddress as Address,
        rEulAddress: reulTokenContractAddress.value as Address,
      })
    }
    catch (e) {
      logWarn('reulLocks/fetch', e)
    }
    finally {
      isLocksLoading.value = false
    }
  }

  watch([isActive, chainId], ([active, currentChainId], [_oldActive, oldChainId]) => {
    if (oldChainId && currentChainId !== oldChainId) {
      isLoaded.value = false
      locks.value = []
    }

    if (!isLoaded.value && effectiveAddress.value) {
      loadREULLocksInfo(effectiveAddress.value)
      isLoaded.value = true
    }

    if (active && !interval) {
      interval = setInterval(() => {
        if (effectiveAddress.value) {
          loadREULLocksInfo(effectiveAddress.value, false)
        }
      }, POLL_INTERVAL_60S_MS)
    }
    else if (!active) {
      locks.value = []
      isLocksLoading.value = false
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }
  }, { immediate: true })

  // Reload when the effective address changes (e.g. wallet switch, spy address resolves to owner)
  watch(effectiveAddress, (addr, oldAddr) => {
    if (oldAddr && addr && addr !== oldAddr) {
      locks.value = []
      isLoaded.value = false
      loadREULLocksInfo(addr)
      isLoaded.value = true
    }
    else if (oldAddr && !addr) {
      locks.value = []
    }
  })

  onUnmounted(() => {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
  })

  const buildUnlockREULPlan = async (lockTimestamps: bigint[]): Promise<TransactionPlan> => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }
    if (!chainId.value) {
      throw new Error('Chain not connected')
    }

    const sdk = await getEulerSdk()
    return sdk.reulLockService.buildUnlockPlan({
      chainId: chainId.value,
      account: wagmiAddress.value as Address,
      lockTimestamp: lockTimestamps[0] as bigint,
      rEulAddress: reulTokenContractAddress.value
        ? (reulTokenContractAddress.value as Address)
        : undefined,
    })
  }

  return {
    locks,
    isLocksLoading,
    reulTokenContractAddress,
    eulTokenContractAddress,
    loadREULLocksInfo: (address: string, isInitial?: boolean) => loadREULLocksInfo(address, isInitial),
    buildUnlockREULPlan,
  }
}
