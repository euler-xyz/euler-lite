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
} | null

const allowedChainIds = ref<number[]>([])
const eulerChainsConfig = ref<Deployment[]>([])
const isLoading = ref(false)
const chainId = ref<number>(0)
const error = ref<string | null>(null)

let initialized = false
let pendingEulerConfigLoad: Promise<void> | undefined

const initAllowedChainIds = () => {
  if (initialized) return
  initialized = true

  const { enabledChainIds } = useChainConfig()
  allowedChainIds.value = [...enabledChainIds]
  chainId.value = allowedChainIds.value[0] || 0
}

export const useEulerAddresses = () => {
  initAllowedChainIds()

  const changeCurrentChainId = (_chainId: number) => {
    if (!allowedChainIds.value.includes(_chainId)) {
      logWarn('useEulerAddresses', `chainId ${_chainId} is not allowed`)
      return
    }
    if (chainId.value === _chainId) return
    chainId.value = _chainId
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
      evkFactoryPerspective: peripheryAddrs.evkFactoryPerspective,
      feeFlowController: peripheryAddrs.feeFlowController,
      governorAccessControlEmergencyFactory: peripheryAddrs.governorAccessControlEmergencyFactory,
      kinkIRMFactory: peripheryAddrs.kinkIRMFactory,
      kinkyIRMFactory: peripheryAddrs.kinkyIRMFactory,
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
    eulerChainsConfig,
    chainId,
    allowedChainIds,
    changeCurrentChainId,
    isLoading,
    error,
    isReady: computed(() => eulerChainsConfig.value.length > 0 && !error.value),
  }
}
