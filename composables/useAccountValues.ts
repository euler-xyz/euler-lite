import { ref, watchEffect } from 'vue'
import { useVaultRegistry } from './useVaultRegistry'
import { useAccountPositions } from './useAccountPositions'
import type { EVault } from '~/entities/vault'
import {
  getAssetUsdValue,
  getCollateralUsdValue,
} from '~/services/pricing/priceProvider'

const totalSuppliedValue = ref(0)
const totalSuppliedValueInfo = ref<{ total: number, hasMissingPrices: boolean }>({ total: 0, hasMissingPrices: false })
const totalBorrowedValue = ref(0)
const totalBorrowedValueInfo = ref<{ total: number, hasMissingPrices: boolean }>({ total: 0, hasMissingPrices: false })

const { depositPositions, borrowPositions } = useAccountPositions()

const updateSupplyValues = async () => {
  const { getVault: registryGetVault } = useVaultRegistry()
  let total = 0
  let hasMissingPrices = false

  for (const position of depositPositions.value) {
    const price = await getAssetUsdValue(position.assets, position.vault, 'off-chain')
    if (price === undefined) {
      hasMissingPrices = true
    }
    total += price ?? 0
  }

  for (const position of borrowPositions.value) {
    const borrowVault = registryGetVault(position.borrow.address) as EVault | undefined
    if (!borrowVault) {
      if (position.supplied > 0n) hasMissingPrices = true
      continue
    }

    const value = await getCollateralUsdValue(position.supplied, borrowVault, position.collateral, 'off-chain')
    if (value === undefined) {
      hasMissingPrices = true
    }
    total += value ?? 0
  }

  totalSuppliedValue.value = total
  totalSuppliedValueInfo.value = { total, hasMissingPrices }
}

const updateBorrowValues = async () => {
  let total = 0
  let hasMissingPrices = false

  for (const pair of borrowPositions.value) {
    const price = await getAssetUsdValue(pair.borrowed, pair.borrow, 'off-chain')
    if (price === undefined) {
      hasMissingPrices = true
    }
    total += price ?? 0
  }

  totalBorrowedValue.value = total
  totalBorrowedValueInfo.value = { total, hasMissingPrices }
}

watchEffect(() => {
  if (depositPositions.value.length || borrowPositions.value.length) {
    updateSupplyValues()
  }
  else {
    totalSuppliedValue.value = 0
    totalSuppliedValueInfo.value = { total: 0, hasMissingPrices: false }
  }
})

watchEffect(() => {
  if (borrowPositions.value.length) {
    updateBorrowValues()
  }
  else {
    totalBorrowedValue.value = 0
    totalBorrowedValueInfo.value = { total: 0, hasMissingPrices: false }
  }
})

export const useAccountValues = () => ({
  totalSuppliedValue,
  totalSuppliedValueInfo,
  totalBorrowedValue,
  totalBorrowedValueInfo,
})
