import type { EVault, PortfolioBorrowPosition, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import type { CollateralOption } from '~/types/collateral-option'
import { buildCollateralOption, computeSupplyApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'

export interface CrossPositionRepayCollateralItem {
  id: string
  vault: EVault
  option: CollateralOption
  sourceAccount: Address
  assets: bigint
  shares: bigint
}

export const buildCrossPositionRepayCollateralCandidates = ({
  positions,
  savingsPositions = [],
  targetPosition,
  liabilityVault,
  enabled,
}: {
  positions: readonly PortfolioBorrowPosition<VaultEntity>[]
  savingsPositions?: readonly PortfolioSavingsPosition<VaultEntity>[]
  targetPosition?: PortfolioBorrowPosition<VaultEntity>
  liabilityVault?: EVault
  enabled: boolean
}) => {
  if (!enabled || !targetPosition || !liabilityVault) return []

  const targetAccount = getAddress(targetPosition.subAccount)
  const liabilityVaultAddress = getAddress(liabilityVault.address)
  const candidates = new Map<string, {
    id: string
    vault: EVault
    sourceAccount: Address
    assets: bigint
    shares: bigint
  }>()

  const addCandidate = (sourceAccountValue: Address, assets: bigint, shares: bigint) => {
    const sourceAccount = getAddress(sourceAccountValue) as Address
    if (sourceAccount === targetAccount) return

    if (assets <= 0n || shares <= 0n) return

    const id = `${sourceAccount.toLowerCase()}:${liabilityVaultAddress.toLowerCase()}`
    candidates.set(id, {
      id,
      vault: liabilityVault,
      sourceAccount,
      assets,
      shares,
    })
  }

  for (const position of positions) {
    const collateral = position.collaterals.find(candidate =>
      getAddress(candidate.vaultAddress) === liabilityVaultAddress,
    )
    if (!collateral) continue
    addCandidate(position.subAccount as Address, collateral.assets, collateral.shares)
  }

  // After the first half of a reciprocal batch, the repaid borrow position is
  // projected as savings. Its collateral flag remains enabled because cleanup
  // is deferred, so keep that exact-vault deposit available for the second leg.
  for (const position of savingsPositions) {
    if (!position.position.isCollateral) continue
    if (getAddress(position.position.vaultAddress) !== liabilityVaultAddress) continue
    addCandidate(position.subAccount as Address, position.assets, position.shares)
  }

  return [...candidates.values()]
}

export const useCrossPositionRepayCollateralOptions = ({
  targetPosition,
  liabilityVault,
}: {
  targetPosition: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  liabilityVault: Ref<EVault | undefined>
}) => {
  const { borrowPositions, depositPositions } = useEulerAccount()
  const { settings } = useUserSettings()
  const { viewer } = useApyVisibility()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)

  const candidates = computed(() => buildCrossPositionRepayCollateralCandidates({
    positions: borrowPositions.value,
    savingsPositions: depositPositions.value,
    targetPosition: targetPosition.value,
    liabilityVault: liabilityVault.value,
    enabled: settings.value.enableAdvancedMode,
  }))

  const items = useReactiveMap(
    candidates,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    async candidate => ({
      ...candidate,
      option: {
        ...await buildCollateralOption({
          vault: candidate.vault,
          type: 'vault',
          amount: nanoToValue(candidate.assets, candidate.vault.asset.decimals),
          priceAmount: nanoToValue(candidate.assets, candidate.vault.asset.decimals),
          apy: computeSupplyApy(candidate.vault, viewer.value, {
            enableIntrinsicApy: enableIntrinsicApy.value,
            enableRewardsApy: enableRewardsApy.value,
          }),
          tagContext: 'supply-source',
        }),
        selectionId: candidate.id,
      },
    } satisfies CrossPositionRepayCollateralItem),
  )

  return { items }
}
