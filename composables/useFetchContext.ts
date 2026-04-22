import type { FetchVaultContext } from '~/entities/vault'

/**
 * Snapshot current composable state into a FetchVaultContext accepted by the
 * pure vault fetchers. Shared by useVaults (primary caller) and useVaultRegistry
 * (on-demand `resolveUnknown` path).
 *
 * Pass an `isAborted` closure to let in-flight generators bail between rounds
 * when the chain switches (useVaults uses its loadGeneration guard; registry's
 * one-shot calls can pass () => false).
 */
export const buildFetchContext = (isAborted: () => boolean = () => false): FetchVaultContext => {
  const { PYTH_HERMES_URL } = useEulerConfig()
  const { rpcUrl } = useRpcClient()
  const { chainId, eulerLensAddresses, eulerCoreAddresses, eulerPeripheryAddresses } = useEulerAddresses()
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()

  if (!eulerLensAddresses.value) {
    throw new Error('Euler addresses not loaded yet')
  }

  return {
    chainId: chainId.value,
    rpcUrl: rpcUrl.value,
    lensAddresses: {
      vaultLens: eulerLensAddresses.value.vaultLens,
      eulerEarnVaultLens: eulerLensAddresses.value.eulerEarnVaultLens,
      utilsLens: eulerLensAddresses.value.utilsLens,
    },
    coreAddresses: { evc: eulerCoreAddresses.value?.evc },
    peripheryAddresses: { escrowedCollateralPerspective: eulerPeripheryAddresses.value?.escrowedCollateralPerspective },
    pythHermesUrl: PYTH_HERMES_URL,
    verifiedVaultAddresses: verifiedVaultAddresses.value,
    earnVaultAddresses: earnVaults.value,
    isAborted,
  }
}
