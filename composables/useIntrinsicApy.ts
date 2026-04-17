import { intrinsicApySources } from '~/entities/custom'
import type { IntrinsicApyInfo, IntrinsicApyProvider, IntrinsicApyResult } from '~/entities/intrinsic-apy'
import { EMPTY_INTRINSIC_APY } from '~/entities/intrinsic-apy'
import { createDefiLlamaProvider } from '~/services/intrinsicApy/defillamaProvider'
import { createPendleProvider } from '~/services/intrinsicApy/pendleProvider'
import { createSecuritizeProvider } from '~/services/intrinsicApy/securitizeProvider'
import { createStablewatchProvider } from '~/services/intrinsicApy/stablewatchProvider'
import { createEtherfiProvider } from '~/services/intrinsicApy/etherfiProvider'
import { createRenzoProvider } from '~/services/intrinsicApy/renzoProvider'
import { createMidasProvider } from '~/services/intrinsicApy/midasProvider'
import { createYoProvider } from '~/services/intrinsicApy/yoProvider'
import { createSparkProvider } from '~/services/intrinsicApy/sparkProvider'
import { createPufferProvider } from '~/services/intrinsicApy/pufferProvider'
import { createTreehouseProvider } from '~/services/intrinsicApy/treehouseProvider'
import { createOndoProvider } from '~/services/intrinsicApy/ondoProvider'
import { createBenqiProvider } from '~/services/intrinsicApy/benqiProvider'
import { createAvantProvider } from '~/services/intrinsicApy/avantProvider'
import { createInfinifiProvider } from '~/services/intrinsicApy/infinifiProvider'
import { logWarn } from '~/utils/errorHandling'
import { CACHE_TTL_5MIN_MS } from '~/entities/tuning-constants'

const intrinsicApyByAddress: Ref<Record<string, IntrinsicApyInfo>> = ref({})
const lastFetchedAt: Ref<number> = ref(0)
const lastFetchedChainId: Ref<number> = ref(0)
const isLoading = ref(false)
const _versionCounter = ref(0)

const normalize = (value?: string) => value?.toLowerCase() || ''

const providers: IntrinsicApyProvider[] = [
  createDefiLlamaProvider(intrinsicApySources),
  createPendleProvider(intrinsicApySources),
  createSecuritizeProvider(intrinsicApySources),
  createStablewatchProvider(intrinsicApySources),
  createEtherfiProvider(intrinsicApySources),
  createRenzoProvider(intrinsicApySources),
  createMidasProvider(intrinsicApySources),
  createYoProvider(intrinsicApySources),
  createSparkProvider(intrinsicApySources),
  createPufferProvider(intrinsicApySources),
  createTreehouseProvider(intrinsicApySources),
  createOndoProvider(intrinsicApySources),
  createBenqiProvider(intrinsicApySources),
  createAvantProvider(intrinsicApySources),
  createInfinifiProvider(intrinsicApySources),
]

const mergeResults = (allResults: IntrinsicApyResult[]): Record<string, IntrinsicApyInfo> => {
  const byAddress: Record<string, IntrinsicApyInfo> = {}
  for (const result of allResults) {
    const existing = byAddress[result.address]
    if (existing) {
      logWarn('intrinsicApy/merge', `Duplicate APY for ${result.address}: "${existing.provider}" (${existing.apy}%) overwritten by "${result.info.provider}" (${result.info.apy}%)`)
    }
    byAddress[result.address] = result.info
  }
  return byAddress
}

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

      const settled = await Promise.allSettled(
        providers.map(p => p.fetch(chainId.value)),
      )

      const allResults: IntrinsicApyResult[] = []
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          allResults.push(...result.value)
        }
      }

      intrinsicApyByAddress.value = mergeResults(allResults)
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

  const getIntrinsicApy = (address?: string) =>
    lookupInfo(address).apy

  const getIntrinsicApyInfo = (address?: string) =>
    lookupInfo(address)

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
