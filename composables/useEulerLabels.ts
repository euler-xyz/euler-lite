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
const labelsByChainId = shallowRef<Map<number, EulerLabelsData>>(new Map())
const labelsChainIds = ref<number[]>([])
const labelsVersion = ref(0)
const isLoading = ref(false)
const isReady = ref(false)
let pendingLabelsLoad: Promise<boolean> | undefined
let pendingLabelsLoadKey = ''
let labelsLoadGeneration = 0
let wrapPairProbeGeneration = 0
const wrapPairs = shallowReactive<Record<string, string>>({})

const setLabelsData = (data: EulerLabelsData, chainIds: readonly number[] = []) => {
  labelsData.value = data
  labelsChainIds.value = [...chainIds]
  labelsVersion.value += 1
}

const setCachedLabelsData = (chainId: number, data: EulerLabelsData) => {
  const next = new Map(labelsByChainId.value)
  next.set(chainId, data)
  labelsByChainId.value = next
}

export const getCurrentEulerLabelsData = (): EulerLabelsData => labelsData.value

export const getEulerLabelsDataForChain = (chainId: number): EulerLabelsData =>
  labelsByChainId.value.get(chainId) ?? labelsData.value

export const getEulerLabelsVersion = (): number => labelsVersion.value

export const getEulerLabelWrapPairs = (): Record<string, string> => wrapPairs

export const __setEulerLabelsDataForTest = (data: Partial<EulerLabelsData> = {}) => {
  setLabelsData({
    ...createEmptyEulerLabelsData(),
    ...data,
    notExplorableEarnVaults: data.notExplorableEarnVaults ?? new Set(),
    assetPatternRules: data.assetPatternRules ?? [],
  } as unknown as EulerLabelsData)
  isReady.value = true
  isLoading.value = false
}

const resolveChainId = async (): Promise<number> => {
  const { getCurrentChainConfig, loadEulerConfig } = useEulerAddresses()

  if (!getCurrentChainConfig.value) {
    void loadEulerConfig()
  }
  await until(getCurrentChainConfig).toBeTruthy()

  return getCurrentChainConfig.value!.chainId
}

const resolveSelectedChainIds = async (): Promise<number[]> => {
  const { selectedChainIds, chainId, loadEulerConfig } = useEulerAddresses()

  void loadEulerConfig()
  if (!selectedChainIds) {
    const current = await resolveChainId()
    return [current]
  }

  await until(selectedChainIds).toMatch(ids => Array.isArray(ids) && ids.length > 0)

  return selectedChainIds.value.length ? selectedChainIds.value : [chainId.value].filter(Boolean)
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const mergeLabelData = (items: EulerLabelsData[]): EulerLabelsData => {
  const merged = createEmptyEulerLabelsData()

  for (const item of items) {
    merged.products = { ...merged.products, ...item.products }
    merged.entities = { ...merged.entities, ...item.entities }
    merged.points = { ...merged.points, ...item.points }
    merged.verifiedVaultAddresses = unique([...merged.verifiedVaultAddresses, ...item.verifiedVaultAddresses])
    merged.earnVaults = unique([...merged.earnVaults, ...item.earnVaults])
    merged.earnVaultEntries = { ...merged.earnVaultEntries, ...item.earnVaultEntries }
    merged.earnVaultBlocks = { ...merged.earnVaultBlocks, ...item.earnVaultBlocks }
    merged.earnVaultRestrictions = { ...merged.earnVaultRestrictions, ...item.earnVaultRestrictions }
    merged.deprecatedEarnVaults = { ...merged.deprecatedEarnVaults, ...item.deprecatedEarnVaults }
    merged.earnVaultDescriptions = { ...merged.earnVaultDescriptions, ...item.earnVaultDescriptions }
    merged.earnVaultNotices = { ...merged.earnVaultNotices, ...item.earnVaultNotices }
    merged.notExplorableEarnVaults = new Set([
      ...merged.notExplorableEarnVaults,
      ...item.notExplorableEarnVaults,
    ])
    merged.assetBlocks = { ...merged.assetBlocks, ...item.assetBlocks }
    merged.assetRestrictions = { ...merged.assetRestrictions, ...item.assetRestrictions }
    merged.assetPatternRules = [...merged.assetPatternRules, ...item.assetPatternRules]
  }

  return merged
}

const products = toReactive(computed(() => labelsData.value.products as Record<string, EulerLabelProduct>))
const entities = toReactive(computed(() => labelsData.value.entities as Record<string, EulerLabelEntity>))
const points = toReactive(computed(() => labelsData.value.points as Record<string, EulerLabelPointReward[]>))
const verifiedVaultAddresses = computed(() => labelsData.value.verifiedVaultAddresses)
const earnVaults = computed(() => labelsData.value.earnVaults)

const loadLabels = async (forceRefresh = false) => {
  const targetChainIds = await resolveSelectedChainIds()
  const targetKey = targetChainIds.join(',')

  if (pendingLabelsLoad && !forceRefresh && pendingLabelsLoadKey === targetKey) return pendingLabelsLoad
  const generation = ++labelsLoadGeneration

  const promise = (async () => {
    if (!forceRefresh && labelsChainIds.value.join(',') === targetKey && isReady.value) return true

    try {
      isReady.value = false
      isLoading.value = true
      const probeGeneration = ++wrapPairProbeGeneration
      Object.keys(wrapPairs).forEach(key => Reflect.deleteProperty(wrapPairs, key))

      if (labelsChainIds.value.join(',') !== targetKey) {
        setLabelsData(createEmptyEulerLabelsData(), targetChainIds)
      }

      if (forceRefresh) {
        await invalidateSdkQueries([...LABEL_QUERY_NAMES])
      }

      const sdk = await getEulerSdk()
      await Promise.all(targetChainIds.map(async (chainId) => {
        if (!forceRefresh && labelsByChainId.value.has(chainId)) return
        setCachedLabelsData(chainId, await sdk.eulerLabelsService.fetchEulerLabelsData(chainId))
      }))
      if (generation !== labelsLoadGeneration) return false
      setLabelsData(mergeLabelData(targetChainIds.map(chainId => getEulerLabelsDataForChain(chainId))), targetChainIds)
      targetChainIds.forEach(chainId => void probeWrapPairs(chainId, probeGeneration))
      return true
    }
    catch (e) {
      logWarn('labels/load', e)
      return true
    }
    finally {
      if (generation === labelsLoadGeneration) {
        isLoading.value = false
        isReady.value = true
      }
    }
  })()

  pendingLabelsLoad = promise
  pendingLabelsLoadKey = targetKey
  try {
    await promise
  }
  finally {
    if (pendingLabelsLoad === promise) {
      pendingLabelsLoad = undefined
      pendingLabelsLoadKey = ''
    }
  }
}

const WRAP_PAIR_PROBE_BATCH_SIZE = 25

const probeWrapPairs = async (startChainId: number, generation: number) => {
  const isCurrentProbe = () =>
    generation === wrapPairProbeGeneration && labelsByChainId.value.has(startChainId)

  try {
    const { getChainConfig } = useEulerAddresses()
    const config = getChainConfig(startChainId)
    if (!config || !isCurrentProbe()) return

    const evcAddress = config.addresses.coreAddrs.evc
    const sdk = await getEulerSdk()
    // The SDK is linked from a workspace and ships its own viem (2.43.x), so
    // its PublicClient is structurally similar but not identical to the app's
    // viem (2.48.x) — cast once at the boundary.
    const provider = sdk.providerService.getProvider(startChainId) as unknown as PublicClient

    const { useVaults } = await import('~/composables/useVaults')
    const { useVaultRegistry } = await import('~/composables/useVaultRegistry')
    const { isReady: isVaultsReady } = useVaults()
    if (!isVaultsReady.value) await until(isVaultsReady).toBe(true)
    if (!isCurrentProbe()) return

    const { getEVaults, getEarnVaults, getSecuritizeVaults } = useVaultRegistry()
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const vault of [...getEVaults(), ...getEarnVaults(), ...getSecuritizeVaults()].filter(v => v.chainId === startChainId)) {
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
    earnVaults,
    loadLabels,
    loadOracleAdapter: oracleAdapters.loadOracleAdapter,
    loadOracleAdapters: oracleAdapters.loadOracleAdapters,
    loadAllOracleAdapters: oracleAdapters.loadAllOracleAdapters,
  }
}

export const useEulerProductOfVault = (vaultAddress: string | Ref<string>, chainId?: number | Ref<number | undefined>) => {
  return toReactive(computed(() => {
    const addr = unref(vaultAddress)
    const data = chainId === undefined ? labelsData.value : getEulerLabelsDataForChain(unref(chainId) || 0)
    const product = getEulerLabelProductByVault(data, addr)
    if (!product) return eulerLabelProductEmpty
    return applyEulerLabelVaultOverrides(product, addr) as EulerLabelProduct
  }))
}

export const useEulerProductOfVaultOnChain = (vaultAddress: string | Ref<string>, chainId: number | Ref<number | undefined>) => {
  return useEulerProductOfVault(vaultAddress, chainId)
}

export const useEulerEntitiesOfVault = (vault: EVault | Ref<EVault>) => {
  return toReactive(computed(() =>
    getEulerLabelEntitiesByVault(getEulerLabelsDataForChain(unref(vault).chainId), unref(vault)) as EulerLabelEntity[],
  ))
}

export const useEulerEntitiesOfEarnVault = (earnVault: EulerEarn | Ref<EulerEarn>) => {
  return toReactive(computed(() =>
    getEulerLabelEntitiesByEarnVault(getEulerLabelsDataForChain(unref(earnVault).chainId), unref(earnVault)) as EulerLabelEntity[],
  ))
}

export const useEulerPointsOfVault = (vaultAddress: string | Ref<string>) => {
  return toReactive(computed(() =>
    getEulerLabelPointsByVault(labelsData.value, unref(vaultAddress)) as EulerLabelPointReward[],
  ))
}
