import { ref, watchEffect } from 'vue'
import { useVaultRegistry } from './useVaultRegistry'
import { useAccountPositions } from './useAccountPositions'
import { useAccountValues } from './useAccountValues'
import type { EVault } from '~/entities/vault'
import {
  getAssetUsdValue,
  getAssetUsdValueOrZero,
  getCollateralUsdValueOrZero,
} from '~/services/pricing/priceProvider'

const portfolioRoe = ref(0)
const portfolioNetApy = ref(0)

export const useAccountPortfolioMetrics = () => {
  const { borrowPositions, depositPositions } = useAccountPositions()
  const { totalSuppliedValueInfo, totalBorrowedValueInfo } = useAccountValues()

  // Must be called in setup context — useIntrinsicApy uses onMounted
  const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, version: intrinsicVersion } = useIntrinsicApy()
  const { getSupplyRewardApy, getBorrowRewardApy, version: rewardsVersion } = useRewardsApy()

  const computePortfolioRoe = async () => {
    const { getVault: registryGetVault } = useVaultRegistry()

    let totalNetYield = 0
    let totalEquity = 0
    let totalSupplyUSD = 0

    for (const position of borrowPositions.value) {
      const registryVault = registryGetVault(position.borrow.address) as EVault | undefined
      const borrowVault = registryVault || position.borrow

      const supplyUSD = await getCollateralUsdValueOrZero(position.supplied, borrowVault, position.collateral, 'off-chain')
      const borrowUSD = (await getAssetUsdValue(position.borrowed, borrowVault, 'off-chain')) ?? 0

      const supplyApy = withIntrinsicSupplyApy(
        getVaultSupplyApy(position.collateral),
        position.collateral.asset.address,
      )
      const borrowApy = withIntrinsicBorrowApy(
        getVaultBorrowApy(position.borrow),
        position.borrow.asset.address,
      )

      const supplyRewardAPY = getSupplyRewardApy(position.collateral.address)
      const borrowRewardAPY = getBorrowRewardApy(position.borrow.address, position.collateral.address)

      const netYield
        = supplyUSD * (supplyApy + supplyRewardAPY)
          - borrowUSD * (borrowApy - borrowRewardAPY)
      const equity = supplyUSD - borrowUSD

      totalNetYield += netYield
      totalEquity += equity
      totalSupplyUSD += supplyUSD
    }

    // Include savings (deposit-only) positions in the portfolio metrics
    for (const position of depositPositions.value) {
      const vault = position.vault
      const supplyUSD = await getAssetUsdValueOrZero(position.assets, vault, 'off-chain')

      const supplyApy = withIntrinsicSupplyApy(
        getVaultSupplyApy(vault),
        vault.asset.address,
      )
      const supplyRewardAPY = getSupplyRewardApy(vault.address)

      const netYield = supplyUSD * (supplyApy + supplyRewardAPY)

      totalNetYield += netYield
      totalEquity += supplyUSD
      totalSupplyUSD += supplyUSD
    }

    portfolioRoe.value = totalEquity > 0 ? totalNetYield / totalEquity : 0
    portfolioNetApy.value = totalSupplyUSD > 0 ? totalNetYield / totalSupplyUSD : 0
  }

  watchEffect(() => {
    const _supplyTotal = totalSuppliedValueInfo.value.total
    const _borrowTotal = totalBorrowedValueInfo.value.total
    void rewardsVersion.value
    void intrinsicVersion.value
    if (borrowPositions.value.length || depositPositions.value.length) {
      computePortfolioRoe()
    }
    else {
      portfolioRoe.value = 0
      portfolioNetApy.value = 0
    }
  })

  return { portfolioRoe, portfolioNetApy }
}
