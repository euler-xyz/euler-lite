import type { PlanRefinancePositionInput } from '~/composables/useEulerTx'

type RefinanceInput = Omit<PlanRefinancePositionInput, 'account'>

export const buildRefinanceIntentArgs = (input: RefinanceInput) => ({
  collateral: input.collateral
    ? input.collateral.swapQuote
      ? {
          planner: 'swap-collateral',
          args: {
            swapQuote: input.collateral.swapQuote,
            swapperMode: input.collateral.swapperMode,
          },
        }
      : {
          planner: 'migrate-same-asset-collateral',
          args: {
            fromVault: input.collateral.fromVault,
            toVault: input.collateral.toVault,
            amount: input.collateral.amount,
            positionAccount: input.collateral.positionAccount,
            fromAsset: input.collateral.fromAsset,
            toAsset: input.collateral.toAsset,
            isMax: input.collateral.isMax,
            maxShares: input.collateral.maxShares,
            enableCollateralTo: input.collateral.enableCollateralTo,
            disableCollateralFrom: input.collateral.disableCollateralFrom,
          },
        }
    : undefined,
  debt: input.debt
    ? input.debt.swapQuote
      ? {
          planner: 'swap-debt',
          args: {
            swapQuote: input.debt.swapQuote,
            swapperMode: input.debt.swapperMode,
          },
        }
      : {
          planner: 'migrate-same-asset-debt',
          args: {
            oldLiabilityVault: input.debt.oldLiabilityVault,
            newLiabilityVault: input.debt.newLiabilityVault,
            liabilityAccount: input.debt.liabilityAccount,
            liabilityAmount: input.debt.liabilityAmount,
            oldLiabilityAsset: input.debt.oldLiabilityAsset,
            newLiabilityAsset: input.debt.newLiabilityAsset,
            sweepExcess: input.debt.sweepExcess,
            transferRemainingSharesToOwner: input.debt.transferRemainingSharesToOwner,
          },
        }
    : undefined,
})
