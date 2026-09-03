import {
  applyEulerLabelVaultOverrides,
  getEulerLabelEntitiesByEarnVault,
  getEulerLabelEntitiesByVault,
  getEulerLabelPointsByVault,
  getEulerLabelProductByVault,
  type EulerEarn,
  type EulerLabelsData,
  type EVault,
} from '@eulerxyz/euler-v2-sdk'
import { toReactive, until } from '@vueuse/core'
import { decodeFunctionResult, encodeFunctionData, type Hex, type PublicClient } from 'viem'
import { computed, ref, shallowReactive, shallowRef, unref, type Ref } from 'vue'
import { logWarn } from '~/utils/errorHandling'
import { invalidateSdkQueries } from '~/utils/sdk-query-cache'
import type { EulerLabelEntity, EulerLabelProduct, EulerLabelPointReward } from '~/entities/euler/labels'
import { eulerLabelProductEmpty } from '~/entities/euler/labels'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { useEulerOracleAdapters } from '~/composables/useEulerOracleAdapters'
import { erc4626AssetAbi } from '~/abis/erc4626'
import { buildBatchItem, evcBatchCall } from '~/utils/multicall'
import { normalizeAddress } from '~/utils/normalizeAddress'

const LABEL_QUERY_NAMES = [
  'queryEulerLabelsEntities',
  'queryEulerLabelsProducts',
  'queryEulerLabelsPoints',
  'queryEulerLabelsEarnVaults',
  'queryEulerLabelsAssets',
] as const

const createEmptyEulerLabelsData = (): EulerLabelsData => ({
  products: {},
  entities: {},
  points: {},
  verifiedVaultAddresses: [],
  earnVaults: [],
  earnVaultEntries: {},
  earnVaultBlocks: {},
  earnVaultRestrictions: {},
  deprecatedEarnVaults: {},
  earnVaultDescriptions: {},
  earnVaultNotices: {},
  notExplorableEarnVaults: new Set(),
  assetBlocks: {},
  assetRestrictions: {},
  assetPatternRules: [],
} as unknown as EulerLabelsData)

const labelsData = shallowRef<EulerLabelsData>(createEmptyEulerLabelsData())
const labelsChainId = ref<number | null>(null)
const labelsVersion = ref(0)
const isLoading = ref(false)
const isReady = ref(false)
const pendingLabelsFetches = new Map<number, Promise<EulerLabelsData>>()
let labelsLoadGeneration = 0
let wrapPairProbeGeneration = 0
const wrapPairs = shallowReactive<Record<string, string>>({})

const setLabelsData = (data: EulerLabelsData, chainId: number | null) => {
  labelsData.value = data
  labelsChainId.value = chainId
  labelsVersion.value += 1
}

export const getCurrentEulerLabelsData = (): EulerLabelsData => labelsData.value

export const getEulerLabelsVersion = (): number => labelsVersion.value

export const getEulerLabelWrapPairs = (): Record<string, string> => wrapPairs

export const __setEulerLabelsDataForTest = (data: Partial<EulerLabelsData> = {}) => {
  labelsLoadGeneration += 1
  wrapPairProbeGeneration += 1
  pendingLabelsFetches.clear()
  Object.keys(wrapPairs).forEach(key => Reflect.deleteProperty(wrapPairs, key))
  setLabelsData({
    ...createEmptyEulerLabelsData(),
    ...data,
    notExplorableEarnVaults: data.notExplorableEarnVaults ?? new Set(),
    assetPatternRules: data.assetPatternRules ?? [],
  } as unknown as EulerLabelsData, null)
  isReady.value = true
  isLoading.value = false
}

const resolveChainId = async (): Promise<number> => {
  const { getCurrentChainConfig, loadEulerConfig } = useEulerAddresses()

  if (getCurrentChainConfig.value) return getCurrentChainConfig.value.chainId

  void loadEulerConfig()
  await until(getCurrentChainConfig).toBeTruthy()

  return getCurrentChainConfig.value!.chainId
}

const products = toReactive(computed(() => labelsData.value.products as Record<string, EulerLabelProduct>))
const entities = toReactive(computed(() => labelsData.value.entities as Record<string, EulerLabelEntity>))
const points = toReactive(computed(() => labelsData.value.points as Record<string, EulerLabelPointReward[]>))
const verifiedVaultAddresses = computed(() => labelsData.value.verifiedVaultAddresses)
const earnVaults = computed(() => labelsData.value.earnVaults)

const isCurrentLabelsLoad = (chainId: number, generation: number) => {
  const { getCurrentChainConfig } = useEulerAddresses()
  return generation === labelsLoadGeneration && getCurrentChainConfig.value?.chainId === chainId
}

const getLabelsFetch = (chainId: number, forceRefresh: boolean) => {
  const pendingFetch = pendingLabelsFetches.get(chainId)
  if (pendingFetch && !forceRefresh) return pendingFetch

  const fetchPromise = (async () => {
    if (forceRefresh) {
      await invalidateSdkQueries([...LABEL_QUERY_NAMES])
    }

    const sdk = await getEulerSdk()
    return sdk.eulerLabelsService.fetchEulerLabelsData(chainId)
  })()

  pendingLabelsFetches.set(chainId, fetchPromise)
  return fetchPromise
}

const loadLabels = async (forceRefresh = false): Promise<void> => {
  const chainId = await resolveChainId()

  const { getCurrentChainConfig } = useEulerAddresses()
  if (getCurrentChainConfig.value?.chainId !== chainId) return
  if (!forceRefresh && labelsChainId.value === chainId && isReady.value) return

  const generation = ++labelsLoadGeneration
  const isCurrentLoad = () => isCurrentLabelsLoad(chainId, generation)
  if (!isCurrentLoad()) return

  isReady.value = false
  isLoading.value = true
  const probeGeneration = ++wrapPairProbeGeneration
  Object.keys(wrapPairs).forEach(key => Reflect.deleteProperty(wrapPairs, key))

  if (labelsChainId.value !== chainId && isCurrentLoad()) {
    setLabelsData(createEmptyEulerLabelsData(), chainId)
  }

  const fetchPromise = getLabelsFetch(chainId, forceRefresh)

  try {
    const data = await fetchPromise
    if (isCurrentLoad()) {
      setLabelsData(data, chainId)
    }
    if (isCurrentLoad()) {
      void probeWrapPairs(chainId, generation, probeGeneration)
    }
  }
  catch (e) {
    logWarn('labels/load', e)
  }
  finally {
    if (pendingLabelsFetches.get(chainId) === fetchPromise) {
      pendingLabelsFetches.delete(chainId)
    }
    if (isCurrentLoad()) {
      isLoading.value = false
      isReady.value = true
    }
  }
}

const WRAP_PAIR_PROBE_BATCH_SIZE = 25

const probeWrapPairs = async (startChainId: number, loadGeneration: number, probeGeneration: number) => {
  const { getCurrentChainConfig } = useEulerAddresses()
  const isCurrentProbe = () =>
    loadGeneration === labelsLoadGeneration
    && probeGeneration === wrapPairProbeGeneration
    && labelsChainId.value === startChainId
    && getCurrentChainConfig.value?.chainId === startChainId

  try {
    const config = getCurrentChainConfig.value
    if (!config || config.chainId !== startChainId || !isCurrentProbe()) return

    const evcAddress = config.addresses.coreAddrs.evc
    const sdk = await getEulerSdk()
    if (!isCurrentProbe()) return
    // The SDK is linked from a workspace and ships its own viem (2.43.x), so
    // its PublicClient is structurally similar but not identical to the app's
    // viem (2.48.x) — cast once at the boundary.
    const provider = sdk.providerService.getProvider(startChainId) as unknown as PublicClient

    const { useVaults } = await import('~/composables/useVaults')
    if (!isCurrentProbe()) return
    const { useVaultRegistry } = await import('~/composables/useVaultRegistry')
    if (!isCurrentProbe()) return
    const { isReady: isVaultsReady } = useVaults()
    if (!isVaultsReady.value) await until(isVaultsReady).toBe(true)
    if (!isCurrentProbe()) return

    const { getEVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const vault of [...getEVaults(), ...getEarnVaults(), ...getSecuritizeVaults()]) {
      const asset = vault.asset
      if (!asset?.address) continue
      const checksummed = normalizeAddress(asset.address)
      if (seen.has(checksummed)) continue
      seen.add(checksummed)
      candidates.push(checksummed)
    }
    if (candidates.length === 0) return

    const callData = encodeFunctionData({ abi: erc4626AssetAbi, functionName: 'asset' })

    for (let offset = 0; offset < candidates.length; offset += WRAP_PAIR_PROBE_BATCH_SIZE) {
      const chunk = candidates.slice(offset, offset + WRAP_PAIR_PROBE_BATCH_SIZE)
      let chunkResults
      try {
        chunkResults = await evcBatchCall(provider, evcAddress, chunk.map(addr => buildBatchItem(addr, callData)))
      }
      catch (err) {
        logWarn('labels/wrap-pairs', err)
        return
      }
      if (!isCurrentProbe()) return

      for (let i = 0; i < chunkResults.length; i++) {
        if (!isCurrentProbe()) return
        const res = chunkResults[i]
        if (!res.success || !res.result || res.result === '0x') continue
        try {
          const decoded = decodeFunctionResult({ abi: erc4626AssetAbi, functionName: 'asset', data: res.result as Hex }) as string
          const underlying = decoded.toLowerCase()
          if (underlying === '0x0000000000000000000000000000000000000000') continue
          wrapPairs[chunk[i].toLowerCase()] = underlying
        }
        catch { /* non-conforming asset() - skip */ }
      }
    }
  }
  catch (e) {
    logWarn('labels/wrap-pairs', e)
  }
}

export const useEulerLabels = () => {
  const oracleAdapters = useEulerOracleAdapters()

  return {
    isLoading,
    isReady,
    verifiedVaultAddresses,
    products,
    entities,
    points,
    oracleAdapters: oracleAdapters.oracleAdapters,
    oracleAssessmentsAvailable: oracleAdapters.oracleAssessmentsAvailable,
    earnVaults,
    loadLabels,
    loadOracleAdapter: oracleAdapters.loadOracleAdapter,
    loadOracleAdapters: oracleAdapters.loadOracleAdapters,
    loadAllOracleAdapters: oracleAdapters.loadAllOracleAdapters,
  }
}

export const useEulerProductOfVault = (vaultAddress: string | Ref<string>) => {
  return toReactive(computed(() => {
    const addr = unref(vaultAddress)
    const product = getEulerLabelProductByVault(labelsData.value, addr)
    if (!product) return eulerLabelProductEmpty
    return applyEulerLabelVaultOverrides(product, addr) as EulerLabelProduct
  }))
}

export const useEulerEntitiesOfVault = (vault: EVault | Ref<EVault>) => {
  return toReactive(computed(() =>
    getEulerLabelEntitiesByVault(labelsData.value, unref(vault)) as EulerLabelEntity[],
  ))
}

export const useEulerEntitiesOfEarnVault = (earnVault: EulerEarn | Ref<EulerEarn>) => {
  return toReactive(computed(() =>
    getEulerLabelEntitiesByEarnVault(labelsData.value, unref(earnVault)) as EulerLabelEntity[],
  ))
}

export const useEulerPointsOfVault = (vaultAddress: string | Ref<string>) => {
  return toReactive(computed(() =>
    getEulerLabelPointsByVault(labelsData.value, unref(vaultAddress)) as EulerLabelPointReward[],
  ))
}
