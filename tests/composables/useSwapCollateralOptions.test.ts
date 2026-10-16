import { computed, effectScope, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maxUint256, zeroAddress, type Address } from 'viem'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { useSwapCollateralOptions } from '~/composables/useSwapCollateralOptions'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'

vi.mock('~/utils/collateralOptions', () => ({
  computeSupplyApy: () => 0,
  buildCollateralOption: async ({ vault }: { vault: EVault }) => ({ vaultAddress: vault.address }),
}))

const FIRST = '0x0000000000000000000000000000000000000101' as Address
const SECOND = '0x0000000000000000000000000000000000000102' as Address
const makeVault = (address: Address): EVault => ({
  type: 'EVault',
  address,
  isEscrow: false,
  totalAssets: 100n,
  caps: { supplyCap: maxUint256 },
  hooks: { hookTarget: zeroAddress, hookedOperations: {} },
  asset: { address, symbol: 'TOK', decimals: 18 },
  collaterals: [],
}) as unknown as EVault

const liability = {
  ...makeVault(zeroAddress),
  collaterals: [FIRST, SECOND].map(address => ({ address, borrowLTV: 0.8 })),
} as unknown as EVault

describe('deployment tags in collateral options', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useEulerLabels', useEulerLabels)
    vi.stubGlobal('useVaults', () => ({ borrowList: ref([]) }))
    vi.stubGlobal('useWallets', () => ({ getBalance: () => 0n }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false }) }))
    vi.stubGlobal('useApyVisibility', () => ({ viewer: ref(undefined) }))
    vi.stubGlobal('nanoToValue', () => 0)
    __setEulerLabelsDataForTest()
    const registry = useVaultRegistry()
    registry.clear()
    for (const address of [FIRST, SECOND]) {
      registry.set(address, makeVault(address), 'evk', { verified: true })
    }
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    useVaultRegistry().clear()
    __setEulerLabelsDataForTest()
    vi.unstubAllGlobals()
  })

  it('retains both existing repayment sources when deployment tags change or match neither vault', async () => {
    // useCollateralSwapRepay requests the existing liability's collateral in this context.
    const sources = scope.run(() => useSwapCollateralOptions({
      currentVault: computed(() => undefined),
      liabilityVault: computed(() => liability),
      tagContext: 'supply-source',
    }))!
    await vi.waitFor(() => expect(sources.collateralOptions.value.map(option => option.vaultAddress)).toEqual([FIRST, SECOND]))

    for (const selected of [[FIRST], [SECOND], []]) {
      __setEulerLabelsDataForTest({ vaultTagAddresses: new Set(selected) })
      // Discovery still follows deployment selection while existing repayment sources do not.
      expect(useVaultRegistry().getVerifiedEVaults().map(vault => vault.address)).toEqual(selected)
      expect(sources.collateralVaults.value.map(vault => vault.address)).toEqual([FIRST, SECOND])
      await vi.waitFor(() => expect(sources.collateralOptions.value.map(option => option.vaultAddress)).toEqual([FIRST, SECOND]))
    }
  })

  it('continues filtering new swap targets and restores all candidates when the filter is unset', async () => {
    __setEulerLabelsDataForTest({ vaultTagAddresses: new Set([FIRST]) })
    const targets = scope.run(() => useSwapCollateralOptions({
      currentVault: computed(() => undefined),
      liabilityVault: computed(() => liability),
    }))!

    for (const selected of [[FIRST], [SECOND], []]) {
      __setEulerLabelsDataForTest({ vaultTagAddresses: new Set(selected) })
      expect(targets.collateralVaults.value.map(vault => vault.address)).toEqual(selected)
      expect(targets.allCollateralVaults.value.map(vault => vault.address)).toEqual(selected)
      await vi.waitFor(() => expect(targets.collateralOptions.value.map(option => option.vaultAddress)).toEqual(selected))
    }
    __setEulerLabelsDataForTest()
    expect(targets.collateralVaults.value.map(vault => vault.address)).toEqual([FIRST, SECOND])
    await vi.waitFor(() => expect(targets.collateralOptions.value.map(option => option.vaultAddress)).toEqual([FIRST, SECOND]))
  })
})
