import type {
  EVault,
  OracleRouteAdapterStep,
  OracleRouteStep,
  SecuritizeCollateralVault,
  getOracleRouteAdapters as getSdkOracleRouteAdapters,
  type OracleAdapterEntry,
} from '@eulerxyz/euler-v2-sdk'

export const isOracleAdapterRouteStep = (
  step: OracleRouteStep,
): step is OracleRouteAdapterStep =>
  step.kind === 'adapter'

export const shouldHideDisplayedVaultStep = (
  step: OracleRouteStep,
  collateralVault: EVault | SecuritizeCollateralVault,
) =>
  step.kind === 'vault'
  && step.base.toLowerCase() === collateralVault.address.toLowerCase()

export const getDebtOracleRouteSteps = (vault: EVault): OracleRouteStep[] =>
  vault.debtPricingOracleRoute?.steps ?? []

export const getCollateralOracleRouteSteps = (
  liability: EVault,
  collateralVault: EVault | SecuritizeCollateralVault,
): OracleRouteStep[] => {
  const collateral = liability.collaterals.find(item =>
    item.address.toLowerCase() === collateralVault.address.toLowerCase(),
  )

  return (collateral?.oracleRoute?.steps ?? [])
    .filter(step => !shouldHideDisplayedVaultStep(step, collateralVault))
}

export const getOracleRouteAdapters = (
  steps: OracleRouteStep[],
): OracleAdapterEntry[] =>
  getSdkOracleRouteAdapters(steps)
