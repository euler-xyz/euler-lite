import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { REULLock } from '~/entities/reul'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import { logWarn } from '~/utils/errorHandling'
import { POLL_INTERVAL_60S_MS } from '~/entities/tuning-constants'
import { createRaceGuard } from '~/utils/race-guard'

const isLoaded = ref(false)
const isLocksLoading = ref(true)
const locks: Ref<REULLock[]> = ref([])

let interval: NodeJS.Timeout | null = null
const pollConsumers = new Map<symbol, () => void>()
const lockGuard = createRaceGuard()

export const useREULLocks = () => {
  const consumerId = Symbol('reul-locks-consumer')
  let released = false
  // The connected wallet stays the transaction signer; only display/query
  // address selection is spy-aware.
  const { address: wagmiAddress, chainId: walletChainId } = useWagmi()
  const { eulerTokenAddresses, chainId: addressesChainId } = useEulerAddresses()
  // Never falls back to the connected wallet while a spy candidate is still
  // verifying — locks would otherwise show the wrong user's balances.
  const { effectiveAddress: spySafeAddress } = useEffectiveAddress()

  const effectiveAddress = computed(() => spySafeAddress.value || '')
  const isActive = computed(() => Boolean(effectiveAddress.value))
  const selectedChainId = computed(() => addressesChainId.value || walletChainId.value)

  const reulTokenContractAddress = computed(() => eulerTokenAddresses.value?.rEUL ?? '')
  const eulTokenContractAddress = computed(() => eulerTokenAddresses.value?.EUL ?? '')
  const addressesReady = computed(() => !!reulTokenContractAddress.value && !!eulTokenContractAddress.value)

  const loadREULLocksInfo = async (userAddress: string, isInitialLoading = true): Promise<REULLock[] | null> => {
    const gen = lockGuard.next()
    if (isInitialLoading) {
      isLocksLoading.value = true
    }
    await until(addressesReady).toBeTruthy({ timeout: 10_000, throwOnTimeout: false })
    if (lockGuard.isStale(gen)) return null
    const chainId = selectedChainId.value
    if (!addressesReady.value || !chainId) {
      if (!lockGuard.isStale(gen)) isLocksLoading.value = false
      return null
    }

    try {
      if (!userAddress) {
        if (lockGuard.isStale(gen)) return null
        locks.value = []
        return []
      }

      const sdk = await getEulerSdkForChain(chainId)
      const nextLocks = await sdk.reulLockService.fetchLocks({
        chainId,
        account: userAddress as Address,
        rEulAddress: reulTokenContractAddress.value as Address,
      })
      if (lockGuard.isStale(gen)) return null
      locks.value = nextLocks
      return nextLocks
    }
    catch (e) {
      if (lockGuard.isStale(gen)) return null
      logWarn('reulLocks/fetch', e)
      return null
    }
    finally {
      if (!lockGuard.isStale(gen)) {
        isLocksLoading.value = false
      }
    }
  }

  const refreshLocks = async (isInitialLoading = false): Promise<REULLock[] | null> => {
    // A required refresh is a transaction-review freshness boundary. Remove
    // the previously rendered rows immediately so stale burn quotes cannot be
    // opened while the replacement RPC is in flight or after it fails.
    if (isInitialLoading) {
      isLocksLoading.value = true
      locks.value = []
    }
    if (!effectiveAddress.value) {
      lockGuard.next()
      locks.value = []
      isLocksLoading.value = false
      return []
    }
    return await loadREULLocksInfo(effectiveAddress.value, isInitialLoading)
  }

  pollConsumers.set(consumerId, () => {
    if (effectiveAddress.value) {
      void loadREULLocksInfo(effectiveAddress.value, false)
    }
  })

  watch([isActive, selectedChainId], ([active, currentChainId], [_oldActive, oldChainId]) => {
    if (oldChainId && currentChainId !== oldChainId) {
      lockGuard.next()
      isLoaded.value = false
      locks.value = []
    }

    if (!isLoaded.value && effectiveAddress.value) {
      loadREULLocksInfo(effectiveAddress.value)
      isLoaded.value = true
    }

    if (active && !interval) {
      interval = setInterval(() => {
        pollConsumers.values().next().value?.()
      }, POLL_INTERVAL_60S_MS)
    }
    else if (!active) {
      lockGuard.next()
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
    if (addr && addr !== oldAddr) {
      lockGuard.next()
      locks.value = []
      isLoaded.value = false
      loadREULLocksInfo(addr)
      isLoaded.value = true
    }
    else if (oldAddr && !addr) {
      lockGuard.next()
      locks.value = []
    }
  })

  onUnmounted(() => {
    if (released) return
    released = true
    pollConsumers.delete(consumerId)
    if (pollConsumers.size === 0 && interval) {
      clearInterval(interval)
      interval = null
    }
  })

  const buildUnlockREULPlan = async (lockTimestamps: bigint[]): Promise<TransactionPlan> => {
    if (!wagmiAddress.value) {
      throw new Error('Wallet not connected')
    }
    const chainId = selectedChainId.value
    if (!chainId) {
      throw new Error('Chain not connected')
    }

    const sdk = await getEulerSdkForChain(chainId)
    return sdk.reulLockService.buildUnlockPlan({
      chainId,
      account: wagmiAddress.value as Address,
      lockTimestamp: lockTimestamps[0] as bigint,
      // Early unlocks can burn the unvested remainder; the review UI displays
      // that loss before building this explicitly opted-in plan.
      allowRemainderLoss: true,
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
    refreshLocks,
    buildUnlockREULPlan,
  }
}
