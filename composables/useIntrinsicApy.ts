import type { IntrinsicApyInfo } from '~/entities/intrinsic-apy'
import { EMPTY_INTRINSIC_APY } from '~/entities/intrinsic-apy'
import { logWarn } from '~/utils/errorHandling'
import { CACHE_TTL_5MIN_MS } from '~/entities/tuning-constants'

const intrinsicApyByAddress: Ref<Record<string, IntrinsicApyInfo>> = ref({})
const lastFetchedAt: Ref<number> = ref(0)
const lastFetchedChainId: Ref<number> = ref(0)
const isLoading = ref(false)
const _versionCounter = ref(0)

const normalize = (value?: string) => value?.toLowerCase() || ''

export const useIntrinsicApy = () => {
  const { chainId } = useEulerAddresses()
  const { settings } = useUserSettings()

  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const isStale = () => Date.now() - lastFetchedAt.value > CACHE_TTL_5MIN_MS
  const isChainChanged = () => lastFetchedChainId.value !== chainId.value

  const loadIntrinsicApy = async () => {
    if (isLoading.value) return
    if (!enableIntrinsicApy.value) {
      intrinsicApyByAddress.value = {}
      return
    }
    if (!isStale() && !isChainChanged()) return

    try {
      isLoading.value = true
      const data = await $fetch<Record<string, IntrinsicApyInfo>>('/api/intrinsic-apy', {
        query: { chainId: chainId.value },
      })
      intrinsicApyByAddress.value = data ?? {}
      lastFetchedAt.value = Date.now()
      lastFetchedChainId.value = chainId.value
    }
    catch (err) {
      logWarn('intrinsicApy/load', err)
      intrinsicApyByAddress.value = {}
    }
    finally {
      isLoading.value = false
    }
  }

  const lookupInfo = (address?: string): IntrinsicApyInfo => {
    if (!enableIntrinsicApy.value) return EMPTY_INTRINSIC_APY
    if (!address) return EMPTY_INTRINSIC_APY
    return intrinsicApyByAddress.value[normalize(address)] ?? EMPTY_INTRINSIC_APY
  }

  const getIntrinsicApy = (address?: string) => lookupInfo(address).apy
  const getIntrinsicApyInfo = (address?: string) => lookupInfo(address)

  const applyIntrinsicApy = (baseApy: number, address?: string) => {
    const intrinsic = getIntrinsicApy(address)
    return baseApy + (1 + baseApy / 100) * intrinsic
  }

  const withIntrinsicSupplyApy = applyIntrinsicApy
  const withIntrinsicBorrowApy = applyIntrinsicApy

  watch(chainId, () => {
    intrinsicApyByAddress.value = {}
    lastFetchedAt.value = 0
    loadIntrinsicApy()
  })

  watch(enableIntrinsicApy, (enabled) => {
    if (enabled) {
      lastFetchedAt.value = 0
      loadIntrinsicApy()
    }
    else {
      intrinsicApyByAddress.value = {}
    }
  })

  const version = computed(() => _versionCounter.value)
  watch(intrinsicApyByAddress, () => {
    _versionCounter.value++
  })

  onMounted(() => {
    loadIntrinsicApy()
  })

  return {
    intrinsicApyByAddress,
    version,
    isLoading: computed(() => isLoading.value),
    isLoaded: computed(() => lastFetchedAt.value > 0),
    loadIntrinsicApy,
    getIntrinsicApy,
    getIntrinsicApyInfo,
    applyIntrinsicApy,
    withIntrinsicSupplyApy,
    withIntrinsicBorrowApy,
  }
}
