import { computed, ref, shallowRef, watch, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, EVault, IHasVaultAddress, PortfolioBorrowPosition, TransactionPlan, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useWalletRepay } from '~/composables/repay/useWalletRepay'

const { USER, borrowVault, collateralVault, planAccount, getCollateralApySnapshot, getNetAPYFromWeightedSupplySnapshot, getAssetUsdValueForEstimate } = vi.hoisted(() => {
  const USER = '0x0000000000000000000000000000000000000001' as `0x${string}`
  const BORROW_VAULT = '0x0000000000000000000000000000000000000002' as `0x${string}`
  const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000003' as `0x${string}`
  const makeVault = (address: string) => ({
    address,
    totalCash: 1_000n,
    totalBorrowed: 100n,
    asset: { address, symbol: 'USDC', decimals: 18 },
    shares: { address, symbol: 'eUSDC', decimals: 18 },
    collaterals: [],
  }) as unknown as EVault

  return {
    USER,
    borrowVault: makeVault(BORROW_VAULT),
    collateralVault: makeVault(COLLATERAL_VAULT),
    planAccount: { chainId: 1 } as Account<IHasVaultAddress>,
    getCollateralApySnapshot: vi.fn(),
    getNetAPYFromWeightedSupplySnapshot: vi.fn(() => 10),
    getAssetUsdValueForEstimate: vi.fn(async () => 10 as number | undefined),
  }
})
const rewardsVersion = ref(0)

vi.mock('#components', () => ({ OperationReviewModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: vi.fn(), close: vi.fn() }),
}))
vi.mock('~/components/ui/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn() }),
}))
vi.mock('~/utils/vault/apy', () => ({
  getNetAPYFromWeightedSupplySnapshot,
  getPositionMultiplier: vi.fn(() => 1),
}))
vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueForEstimate,
}))
vi.mock('~/utils/position-estimates', () => ({
  getTotalCollateralValue: vi.fn(() => 10_000),
}))
vi.mock('~/utils/ltv', () => ({
  getBorrowPositionEffectiveLiquidationLTV: vi.fn(() => 0.8),
  decimalLtvToBps: vi.fn(() => 8_000n),
}))
vi.mock('~/utils/vault-display', () => ({
  getVaultBorrowApy: vi.fn(() => 5),
}))
vi.mock('~/utils/vault-intrinsic-apy', () => ({
  withProjectedVaultIntrinsicApy: vi.fn((_current: number, projected: number) => projected),
}))

const position = {
  subAccount: USER,
  borrowed: 2_000n * 10n ** 18n,
  supplied: 10_000n * 10n ** 18n,
  collateralVaults: [collateralVault.address],
  collaterals: [],
} as unknown as PortfolioBorrowPosition<VaultEntity>

describe('useWalletRepay projected Net APY', () => {
  beforeEach(() => {
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: vi.fn() }))
    vi.stubGlobal('useExecutionReview', () => ({ open: vi.fn() }))
    vi.clearAllMocks()
    rewardsVersion.value = 0
    getCollateralApySnapshot.mockImplementation(async (_position, _vault, options?: { liabilityRateDelta?: unknown }) => ({
      supplyUsd: 1_000,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [collateralVault.address],
      entries: [],
      liabilityProjectedRates: options?.liabilityRateDelta
        ? { supplyAPY: 0n, borrowAPY: 7n * 10n ** 25n }
        : null,
      isComplete: true,
    }))
    getAssetUsdValueForEstimate.mockResolvedValue(10)
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('useDebounceFn', (fn: unknown) => fn)
    vi.stubGlobal('useEulerTx', () => ({
      planRepayFromWallet: vi.fn(async () => ({ type: 'plan' }) as unknown as TransactionPlan),
      executePlan: vi.fn(),
    }))
    vi.stubGlobal('usePlanAccount', () => ({ account: shallowRef(planAccount) }))
    vi.stubGlobal('useStateOverrideOptions', () => ({ primeSlotHintsFor: vi.fn() }))
    vi.stubGlobal('useWagmi', () => ({ isConnected: ref(true) }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useTxFinalization', () => ({ finalizeTxAndRedirect: vi.fn() }))
    vi.stubGlobal('useVaultRegistry', () => ({ getVault: vi.fn() }))
    vi.stubGlobal('usePositionCollateralApy', () => ({
      getCollateralApySnapshot,
    }))
    vi.stubGlobal('useRewardsApy', () => ({
      version: rewardsVersion,
      getBorrowRewardApyForCollaterals: vi.fn(() => 0),
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
      getBorrowRewardCampaignsForCollaterals: vi.fn(() => []),
      getEligibleLoopingRewardCampaignsForCollaterals: vi.fn(() => []),
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('clears an earlier Net APY estimate when the next projection rejects', async () => {
    const repay = useWalletRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      walletBalance: ref(1_000n * 10n ** 18n),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(async () => true),
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })

    repay.amount.value = '100'
    await vi.waitFor(() => expect(repay.estimateNetAPY.value).toBeCloseTo(4.93))

    getCollateralApySnapshot
      .mockImplementationOnce(async () => ({
        supplyUsd: 1_000,
        weightedSupplyApy: 5,
        weightedBaseSupplyApy: 5,
        weightedIntrinsicSupplyApy: 0,
        weightedSupplyRewardApy: 0,
        collateralAddresses: [collateralVault.address],
        entries: [],
        liabilityProjectedRates: null,
        isComplete: true,
      }))
      .mockRejectedValueOnce(new Error('projection failed'))
    repay.amount.value = '200'

    await vi.waitFor(() => expect(repay.estimateNetAPY.value).toBeNull())
  })

  it('does not expose projected details when synchronous validation fails', async () => {
    const repay = useWalletRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      walletBalance: ref(1_000n * 10n ** 18n),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(async () => true),
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })

    repay.amount.value = '100'
    await vi.waitFor(() => expect(repay.projectedYieldDetails.value).not.toBeNull())
    getCollateralApySnapshot.mockClear()

    repay.amount.value = '2001'
    await vi.waitFor(() => expect(repay.estimatesError.value).toBe('Not enough balance'))

    expect(getCollateralApySnapshot).not.toHaveBeenCalled()
    expect(repay.projectedYieldDetails.value).toBeNull()
  })

  it('keeps projected yield unavailable when positive debt has no USD price', async () => {
    getAssetUsdValueForEstimate.mockResolvedValue(undefined)
    const repay = useWalletRepay({
      position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      walletBalance: ref(1_000n * 10n ** 18n),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(async () => true),
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })

    repay.amount.value = '100'

    await vi.waitFor(() => expect(getAssetUsdValueForEstimate).toHaveBeenCalled())
    expect(repay.estimateNetAPY.value).toBeNull()
    expect(repay.projectedYieldDetails.value).toBeNull()
  })

  it('invalidates an in-flight projection when the layered position disappears', async () => {
    let resolveProjection!: (value: Awaited<ReturnType<typeof getCollateralApySnapshot>>) => void
    getCollateralApySnapshot
      .mockImplementationOnce(async () => ({
        supplyUsd: 1_000,
        weightedSupplyApy: 5,
        weightedBaseSupplyApy: 5,
        weightedIntrinsicSupplyApy: 0,
        weightedSupplyRewardApy: 0,
        collateralAddresses: [collateralVault.address],
        entries: [],
        liabilityProjectedRates: null,
        isComplete: true,
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveProjection = resolve
      }))
    const positionRef = shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position)
    const repay = useWalletRepay({
      position: positionRef,
      borrowVault: computed(() => borrowVault),
      collateralVault: computed(() => collateralVault),
      formTab: ref('wallet'),
      walletBalance: ref(1_000n * 10n ** 18n),
      plan: ref(null),
      isSubmitting: ref(false),
      isPreparing: ref(false),
      clearSimulationError: vi.fn(),
      runSimulation: vi.fn(async () => true),
      netAPY: ref(1),
      collateralSupplyApy: computed(() => 5),
      borrowApy: computed(() => 5),
      collateralSupplyRewardApy: computed(() => 0),
      borrowRewardApy: computed(() => 0),
      oraclePriceRatio: computed(() => 1),
    })

    repay.amount.value = '100'
    await vi.waitFor(() => expect(getCollateralApySnapshot).toHaveBeenCalledTimes(2))
    positionRef.value = undefined
    resolveProjection({
      supplyUsd: 1_000,
      weightedSupplyApy: 5,
      weightedBaseSupplyApy: 5,
      weightedIntrinsicSupplyApy: 0,
      weightedSupplyRewardApy: 0,
      collateralAddresses: [collateralVault.address],
      entries: [],
      liabilityProjectedRates: { supplyAPY: 0n, borrowAPY: 7n * 10n ** 25n },
      isComplete: true,
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(repay.projectedYieldDetails.value).toBeNull()
    expect(repay.isEstimatesLoading.value).toBe(false)
  })
})
