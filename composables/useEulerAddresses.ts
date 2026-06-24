import type { Deployment } from '@eulerxyz/euler-v2-sdk'
import { logWarn } from '~/utils/errorHandling'

export type EulerLensAddresses = {
  accountLens: string
  eulerEarnVaultLens: string
  irmLens: string
  oracleLens: string
  utilsLens: string
  vaultLens: string
} | null

export type EulerTokenAddresses = {
  EUL: string | undefined
  rEUL: string | undefined
  eUSD: string | undefined
  seUSD: string | undefined
} | null

const allowedChainIds = ref<number[]>([])
const selectedChainIds = ref<number[]>([])
const eulerChainsConfig = ref<Deployment[]>([])
const isLoading = ref(false)
const chainId = ref<number>(0)
const error = ref<string | null>(null)

let initialized = false
let pendingEulerConfigLoad: Promise<void> | undefined

const initAllowedChainIds = () => {
  if (initialized) return
  initialized = true

  const { enabledChainIds, deprecatedChainIds } = useChainConfig()
  allowedChainIds.value = [...enabledChainIds]
  selectedChainIds.value = allowedChainIds.value.filter(id => !deprecatedChainIds.includes(id))
  if (!selectedChainIds.value.length) {
    selectedChainIds.value = [...allowedChainIds.value]
  }
  chainId.value = selectedChainIds.value[0] || allowedChainIds.value[0] || 0
}

export const useEulerAddresses = () => {
  initAllowedChainIds()

  const normalizeSelectedChainIds = (chainIds: readonly number[]): number[] => {
    const allowed = new Set(allowedChainIds.value)
    const next = [...new Set(chainIds)]
      .filter(id => allowed.has(id))
      .sort((a, b) => a - b)

    return next.length ? next : [chainId.value || allowedChainIds.value[0]].filter(Boolean)
  }

  const setSelectedChainIds = (_chainIds: readonly number[]) => {
    const next = normalizeSelectedChainIds(_chainIds)
    if (
      next.length === selectedChainIds.value.length
      && next.every((id, index) => id === selectedChainIds.value[index])
    ) {
      return
    }

    selectedChainIds.value = next
    if (!selectedChainIds.value.includes(chainId.value)) {
      chainId.value = selectedChainIds.value[0] || 0
    }
  }

  const toggleSelectedChainId = (_chainId: number, selected?: boolean) => {
    const selectedSet = new Set(selectedChainIds.value)
    const shouldSelect = selected ?? !selectedSet.has(_chainId)

    if (shouldSelect) {
      selectedSet.add(_chainId)
    }
    else {
      selectedSet.delete(_chainId)
    }

    setSelectedChainIds([...selectedSet])
  }

  const changeCurrentChainId = (_chainId: number) => {
    if (!allowedChainIds.value.includes(_chainId)) {
      logWarn('useEulerAddresses', `chainId ${_chainId} is not allowed`)
      return
    }
    if (chainId.value === _chainId) return
    chainId.value = _chainId
    if (!selectedChainIds.value.includes(_chainId)) {
      setSelectedChainIds([...selectedChainIds.value, _chainId])
    }
  }

  const loadEulerConfig = async () => {
    if (eulerChainsConfig.value.length > 0) return
    if (pendingEulerConfigLoad) return pendingEulerConfigLoad

    const promise = (async () => {
      isLoading.value = true
      error.value = null

      try {
        const { getEulerSdk } = await import('~/composables/useEulerSdk')
        const sdk = await getEulerSdk()
        const data = sdk.deploymentService
          .getDeploymentChainIds()
          .map(chainId => sdk.deploymentService.getDeployment(chainId))
        const filteredData = data.filter(chain => allowedChainIds.value.includes(chain.chainId))

        if (!filteredData.length) {
          logWarn('useEulerAddresses', 'enabledChainIds did not match any remote chains, using full list')
        }

        eulerChainsConfig.value = filteredData.length ? filteredData : data
      }
      catch (err) {
        error.value = err instanceof Error ? err.message : 'Unknown error'
        logWarn('useEulerAddresses', err, { severity: 'error' })
      }
      finally {
        isLoading.value = false
      }
    })()

    pendingEulerConfigLoad = promise
    try {
      await promise
    }
    finally {
      if (pendingEulerConfigLoad === promise) pendingEulerConfigLoad = undefined
    }
  }

  const getCurrentChainConfig = computed(() => {
    if (eulerChainsConfig.value.length === 0) return undefined

    const targetChainId = chainId.value || allowedChainIds.value.find(id => eulerChainsConfig.value.some(chain => chain.chainId === id)) || null

    if (targetChainId) {
      return eulerChainsConfig.value.find(chain => chain.chainId === targetChainId)
    }

    return eulerChainsConfig.value[0]
  })

  const getChainConfig = (targetChainId: number) =>
    eulerChainsConfig.value.find(chain => chain.chainId === targetChainId)

  const selectedChainConfigs = computed(() =>
    selectedChainIds.value
      .map(getChainConfig)
      .filter((chain): chain is Deployment => Boolean(chain)),
  )

  const eulerLensAddresses = computed(() => {
    const config = getCurrentChainConfig.value
    if (!config) return null

    return {
      accountLens: config.addresses.lensAddrs.accountLens,
      eulerEarnVaultLens: config.addresses.lensAddrs.eulerEarnVaultLens,
      irmLens: config.addresses.lensAddrs.irmLens,
      oracleLens: config.addresses.lensAddrs.oracleLens,
      utilsLens: config.addresses.lensAddrs.utilsLens,
      vaultLens: config.addresses.lensAddrs.vaultLens,
    }
  })

  const eulerCoreAddresses = computed(() => {
    const config = getCurrentChainConfig.value
    if (!config) return null

    return {
      balanceTracker: config.addresses.coreAddrs.balanceTracker,
      eVaultFactory: config.addresses.coreAddrs.eVaultFactory,
      eVaultImplementation: config.addresses.coreAddrs.eVaultImplementation,
      eulerEarnFactory: config.addresses.coreAddrs.eulerEarnFactory,
      evc: config.addresses.coreAddrs.evc,
      permit2: config.addresses.coreAddrs.permit2,
      protocolConfig: config.addresses.coreAddrs.protocolConfig,
      sequenceRegistry: config.addresses.coreAddrs.sequenceRegistry,
    }
  })

  const eulerTokenAddresses = computed<EulerTokenAddresses>(() => {
    const config = getCurrentChainConfig.value
    if (!config?.addresses.tokenAddrs) return null
    return {
      EUL: config.addresses.tokenAddrs.EUL,
      rEUL: config.addresses.tokenAddrs.rEUL,
      eUSD: config.addresses.tokenAddrs.eUSD,
      seUSD: config.addresses.tokenAddrs.seUSD,
    }
  })

  const eulerPeripheryAddresses = computed(() => {
    const config = getCurrentChainConfig.value
    if (!config) return null
    const peripheryAddrs = config.addresses.peripheryAddrs ?? {}

    return {
      adaptiveCurveIRMFactory: peripheryAddrs.adaptiveCurveIRMFactory,
      capRiskStewardFactory: peripheryAddrs.capRiskStewardFactory,
      escrowedCollateralPerspective: peripheryAddrs.escrowedCollateralPerspective,
      eulerEarnFactoryPerspective: peripheryAddrs.eulerEarnFactoryPerspective,
      eulerEarnGovernedPerspective: peripheryAddrs.eulerEarnGovernedPerspective,
      eulerUngoverned0xPerspective: peripheryAddrs.eulerUngoverned0xPerspective,
      eulerUngovernedNzxPerspective: peripheryAddrs.eulerUngovernedNzxPerspective,
      evkFactoryPerspective: peripheryAddrs.evkFactoryPerspective,
      externalVaultRegistry: peripheryAddrs.externalVaultRegistry,
      feeFlowController: peripheryAddrs.feeFlowController,
      governedPerspective: peripheryAddrs.governedPerspective,
      governorAccessControlEmergencyFactory: peripheryAddrs.governorAccessControlEmergencyFactory,
      irmRegistry: peripheryAddrs.irmRegistry,
      kinkIRMFactory: peripheryAddrs.kinkIRMFactory,
      kinkyIRMFactory: peripheryAddrs.kinkyIRMFactory,
      oracleAdapterRegistry: peripheryAddrs.oracleAdapterRegistry,
      oracleRouterFactory: peripheryAddrs.oracleRouterFactory,
      securitizeFactory: peripheryAddrs.securitizeFactory,
      swapVerifier: peripheryAddrs.swapVerifier,
      swapper: peripheryAddrs.swapper,
      termsOfUseSigner: peripheryAddrs.termsOfUseSigner,
    }
  })

  return {
    loadEulerConfig,
    eulerLensAddresses,
    eulerCoreAddresses,
    eulerPeripheryAddresses,
    eulerTokenAddresses,
    getCurrentChainConfig,
    getChainConfig,
    selectedChainConfigs,
    eulerChainsConfig,
    chainId,
    selectedChainIds,
    allowedChainIds,
    changeCurrentChainId,
    setSelectedChainIds,
    toggleSelectedChainId,
    isLoading,
    error,
    isReady: computed(() => eulerChainsConfig.value.length > 0 && !error.value),
  }
}
