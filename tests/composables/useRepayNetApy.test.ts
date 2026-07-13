import { computed, effectScope, nextTick, ref, shallowRef, watchEffect, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import { useRepayNetApy } from '~/composables/repay/useRepayNetApy'

const { getAssetUsdValueOrZero, getNetAPYFromWeightedSupplySnapshot, logWarn } = vi.hoisted(() => ({
  getAssetUsdValueOrZero: vi.fn(async () => 50),
  getNetAPYFromWeightedSupplySnapshot: vi.fn((snapshot: CollateralApySnapshot) => snapshot.weightedSupplyApy),
  logWarn: vi.fn(),
}))

vi.mock('~/utils/sdk-prices', () => ({ getAssetUsdValueOrZero }))
vi.mock('~/utils/vault/apy', () => ({
  getNetAPYFromWeightedSupplySnapshot,
  getPositionMultiplier: vi.fn(() => 2),
}))
vi.mock('~/utils/vault-display', () => ({
  getVaultBorrowApy: vi.fn(() => 4),
  getVaultSupplyApy: vi.fn(() => 5),
}))
vi.mock('~/utils/vault-intrinsic-apy', () => ({
  withVaultIntrinsicApy: vi.fn((apy: number) => apy),
}))
vi.mock('~/utils/errorHandling', () => ({ logWarn }))

const BORROW_VAULT = '0x0000000000000000000000000000000000000001'
const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000002'

const borrowVault = {
  address: BORROW_VAULT,
  asset: { address: BORROW_VAULT, symbol: 'USDC', decimals: 6 },
  shares: { decimals: 6 },
} as unknown as EVault
const collateralVault = {
  address: COLLATERAL_VAULT,
  asset: { address: COLLATERAL_VAULT, symbol: 'WETH', decimals: 18 },
  shares: { decimals: 18 },
} as unknown as EVault
const position = {
  borrowed: 100n,
  collateralVaults: [COLLATERAL_VAULT],
} as unknown as PortfolioBorrowPosition<VaultEntity>

const snapshot = (weightedSupplyApy: number): CollateralApySnapshot => ({
  supplyUsd: 100,
  weightedSupplyApy,
  weightedBaseSupplyApy: weightedSupplyApy,
  weightedIntrinsicSupplyApy: 0,
  weightedSupplyRewardApy: 0,
  collateralAddresses: [COLLATERAL_VAULT],
  entries: [],
  isComplete: true,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useRepayNetApy', () => {
  const rewardsVersion = ref(0)
  const getCollateralApySnapshot = vi.fn(async () => snapshot(5))
  let scope: EffectScope

  beforeEach(() => {
    vi.clearAllMocks()
    rewardsVersion.value = 0
    getAssetUsdValueOrZero.mockResolvedValue(50)
    getCollateralApySnapshot.mockResolvedValue(snapshot(5))
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getSupplyRewardApy: vi.fn(() => 0),
      getBorrowRewardApyForCollaterals: vi.fn(() => 0),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
    }))
    vi.stubGlobal('usePositionCollateralApy', () => ({ getCollateralApySnapshot }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const makeBaseline = () => scope.run(() => useRepayNetApy({
    position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
    borrowVault: computed(() => borrowVault),
    collateralVault: computed(() => collateralVault),
  }))!

  it('clears the baseline while refreshing and ignores a superseded completion', async () => {
    const baseline = makeBaseline()
    await vi.waitFor(() => expect(baseline.netAPY.value).toBe(5))

    const replacement = deferred<CollateralApySnapshot>()
    getCollateralApySnapshot.mockReturnValueOnce(replacement.promise)
    rewardsVersion.value++
    await nextTick()
    expect(baseline.netAPY.value).toBeNull()

    getCollateralApySnapshot.mockResolvedValueOnce(snapshot(9))
    rewardsVersion.value++
    await vi.waitFor(() => expect(baseline.netAPY.value).toBe(9))

    replacement.resolve(snapshot(7))
    await nextTick()
    await Promise.resolve()
    expect(baseline.netAPY.value).toBe(9)
  })

  it('keeps the baseline unavailable when the active refresh rejects', async () => {
    const baseline = makeBaseline()
    await vi.waitFor(() => expect(baseline.netAPY.value).toBe(5))

    getAssetUsdValueOrZero.mockRejectedValueOnce(new Error('price failed'))
    rewardsVersion.value++

    await vi.waitFor(() => expect(logWarn).toHaveBeenCalledWith(
      'repay/currentNetApy',
      expect.objectContaining({ message: 'price failed' }),
    ))
    expect(baseline.netAPY.value).toBeNull()
  })
})
