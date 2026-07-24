import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { usePositionCollateralApy } from '~/composables/usePositionCollateralApy'
import { activeLayerVaultsRef } from '~/composables/useLayeredVaults'

const { getProjectedRatesBatch, getCollateralUsdValue, getOrFetch } = vi.hoisted(() => ({
  getProjectedRatesBatch: vi.fn(async (requests: unknown[]) => requests.map(() => ({
    supplyAPY: 8n * 10n ** 25n,
    borrowAPY: 0n,
  }))),
  getCollateralUsdValue: vi.fn(async (assets: bigint) => Number(assets)),
  getOrFetch: vi.fn(),
}))

vi.mock('~/utils/vault/apy', () => ({ getProjectedRatesBatch }))
vi.mock('~/utils/sdk-prices', () => ({ getCollateralUsdValue }))
vi.mock('~/utils/vault-display', () => ({
  getVaultSupplyApy: vi.fn((vault: { currentApy?: number }) => vault.currentApy ?? 0),
}))

const VAULT_A = '0x0000000000000000000000000000000000000001'
const VAULT_B = '0x0000000000000000000000000000000000000002'
const LIABILITY = '0x0000000000000000000000000000000000000003'

const makeVault = (address: string, currentApy: number) => ({
  type: 'EVault',
  address,
  currentApy,
  totalCash: 1_000n,
  totalBorrowed: 500n,
  asset: { address, decimals: 18 },
  shares: { decimals: 18 },
}) as unknown as EVault

const vaultA = makeVault(VAULT_A, 5)
const vaultB = makeVault(VAULT_B, 10)
const liabilityVault = makeVault(LIABILITY, 0)

const makePosition = (collateralVaults = [VAULT_A, VAULT_B]) => ({
  collateral: { vaultAddress: VAULT_A },
  supplied: 100n,
  collateralVaults,
  collaterals: [
    { vaultAddress: VAULT_A, vault: vaultA, assets: 100n },
    { vaultAddress: VAULT_B, vault: vaultB, assets: 100n },
  ],
}) as unknown as PortfolioBorrowPosition<VaultEntity>

describe('usePositionCollateralApy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeLayerVaultsRef.value = {}
    getOrFetch.mockImplementation(async (address: string) => ({
      [VAULT_A.toLowerCase()]: vaultA,
      [VAULT_B.toLowerCase()]: vaultB,
    })[address.toLowerCase()])
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useRewardsApy', () => ({
      version: ref(1),
      getSupplyRewardApy: vi.fn(() => 1),
      getSupplyRewardCampaigns: vi.fn(() => []),
    }))
    vi.stubGlobal('useVaultRegistry', () => ({
      getOrFetch,
    }))
    vi.stubGlobal('useVaults', () => ({
      isReady: ref(true),
      isMarketDataResolved: ref(true),
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
    vi.stubGlobal('until', () => ({ toBe: async () => {} }))
  })

  afterEach(() => {
    activeLayerVaultsRef.value = {}
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('weights every collateral and projects the changed vault in one snapshot', async () => {
    const { getCollateralApySnapshot } = usePositionCollateralApy()
    const snapshot = await getCollateralApySnapshot(makePosition(), liabilityVault, {
      deltas: [{ vaultAddress: VAULT_A, assetsDelta: 50n, projectRates: true }],
    })

    expect(getProjectedRatesBatch).toHaveBeenCalledWith([expect.objectContaining({
      vaultAddress: VAULT_A,
      cashDelta: 50n,
    })])
    expect(snapshot.supplyUsd).toBe(250)
    expect(snapshot.weightedSupplyApy).toBeCloseTo((150 * 9 + 100 * 11) / 250)
    expect(snapshot.weightedBaseSupplyApy).toBeCloseTo((150 * 8 + 100 * 10) / 250)
    expect(snapshot.weightedIntrinsicSupplyApy).toBe(0)
    expect(snapshot.weightedSupplyRewardApy).toBe(1)
    expect(snapshot.entries).toEqual([
      expect.objectContaining({ address: VAULT_A, supplyUsd: 150, baseSupplyApy: 8, supplyRewardApy: 1 }),
      expect.objectContaining({ address: VAULT_B, supplyUsd: 100, baseSupplyApy: 10, supplyRewardApy: 1 }),
    ])
    expect(snapshot.collateralAddresses).toEqual([VAULT_A, VAULT_B])
    expect(snapshot.isComplete).toBe(true)
  })

  it('projects a vault cash change without changing the position assets', async () => {
    const { getCollateralApySnapshot } = usePositionCollateralApy()
    const snapshot = await getCollateralApySnapshot(makePosition(), liabilityVault, {
      deltas: [{
        vaultAddress: VAULT_A,
        assetsDelta: 0n,
        cashDelta: -25n,
        projectRates: true,
      }],
    })

    expect(getProjectedRatesBatch).toHaveBeenCalledWith([expect.objectContaining({
      vaultAddress: VAULT_A,
      cashDelta: -25n,
    })])
    expect(snapshot.supplyUsd).toBe(200)
    expect(snapshot.entries[0]).toMatchObject({
      address: VAULT_A,
      assets: 100n,
      supplyUsd: 100,
      baseSupplyApy: 8,
    })
  })

  it('projects same-vault collateral and liability deltas as one snapshot', async () => {
    const { getCollateralApySnapshot } = usePositionCollateralApy()
    const snapshot = await getCollateralApySnapshot(makePosition(), vaultA, {
      deltas: [{
        vaultAddress: VAULT_A,
        assetsDelta: 20n,
        cashDelta: 20n,
        projectRates: true,
      }],
      liabilityRateDelta: {
        cashDelta: -10n,
        borrowsDelta: 10n,
      },
    })

    expect(getProjectedRatesBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        vaultAddress: VAULT_A,
        cashDelta: 20n,
        borrowsDelta: 0n,
      }),
      expect.objectContaining({
        vaultAddress: VAULT_A,
        cashDelta: -10n,
        borrowsDelta: 10n,
      }),
    ])
    expect(snapshot.entries[0]?.baseSupplyApy).toBe(8)
    expect(snapshot.liabilityProjectedRates).toEqual({
      supplyAPY: 8n * 10n ** 25n,
      borrowAPY: 0n,
    })
    expect(snapshot.isComplete).toBe(true)
  })

  it('uses the simulated collateral vault state instead of the layer-zero registry state', async () => {
    const simulatedVaultA = {
      ...vaultA,
      currentApy: 6,
      totalCash: 900n,
      totalBorrowed: 450n,
    } as unknown as EVault
    const position = {
      ...makePosition(),
      collateral: { vaultAddress: VAULT_A, vault: simulatedVaultA, assets: 100n },
      collaterals: [
        { vaultAddress: VAULT_A, vault: simulatedVaultA, assets: 100n },
        { vaultAddress: VAULT_B, vault: vaultB, assets: 100n },
      ],
    } as unknown as PortfolioBorrowPosition<VaultEntity>
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    const snapshot = await getCollateralApySnapshot(position, liabilityVault, {
      deltas: [{ vaultAddress: VAULT_A, assetsDelta: -25n, projectRates: true }],
    })

    expect(getProjectedRatesBatch).toHaveBeenCalledWith([expect.objectContaining({
      vaultAddress: VAULT_A,
      currentCash: 900n,
      currentBorrows: 450n,
      cashDelta: -25n,
    })])
    expect(snapshot.entries[0]?.vault).toBe(simulatedVaultA)
  })

  it('falls back to the registry when a matching collateral position is unenriched', async () => {
    const position = {
      ...makePosition(),
      collateral: { vaultAddress: VAULT_A, assets: 100n },
      collaterals: [
        { vaultAddress: VAULT_A, assets: 100n },
        { vaultAddress: VAULT_B, vault: vaultB, assets: 100n },
      ],
    } as unknown as PortfolioBorrowPosition<VaultEntity>
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    const snapshot = await getCollateralApySnapshot(position, liabilityVault)

    expect(getOrFetch).toHaveBeenCalledWith(VAULT_A)
    expect(snapshot.isComplete).toBe(true)
    expect(snapshot.entries[0]?.vault).toBe(vaultA)
  })

  it('uses a simulated layer vault for a newly introduced collateral address', async () => {
    const simulatedVault = {
      ...liabilityVault,
      totalCash: 750n,
      totalBorrowed: 300n,
    } as unknown as EVault
    activeLayerVaultsRef.value = { [LIABILITY.toLowerCase()]: simulatedVault }
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    const snapshot = await getCollateralApySnapshot(makePosition(), liabilityVault, {
      deltas: [{ vaultAddress: LIABILITY, assetsDelta: 25n, projectRates: true }],
    })

    expect(getProjectedRatesBatch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        vaultAddress: LIABILITY,
        currentCash: 750n,
        currentBorrows: 300n,
      }),
    ]))
    expect(snapshot.entries.find(entry => entry.address === LIABILITY)?.vault).toBe(simulatedVault)
  })

  it('fails closed when a requested projected rate is unavailable', async () => {
    getProjectedRatesBatch.mockResolvedValueOnce([null])
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    await expect(getCollateralApySnapshot(makePosition(), liabilityVault, {
      deltas: [{ vaultAddress: VAULT_A, assetsDelta: 50n, projectRates: true }],
    })).resolves.toEqual({
      supplyUsd: 0,
      weightedSupplyApy: null,
      weightedBaseSupplyApy: null,
      weightedIntrinsicSupplyApy: null,
      weightedSupplyRewardApy: null,
      collateralAddresses: [],
      entries: [],
      liabilityProjectedRates: null,
      isComplete: false,
    })
  })

  it('fails closed when an expected collateral position is unresolved', async () => {
    const { getCollateralApySnapshot } = usePositionCollateralApy()
    const position = makePosition([VAULT_A, VAULT_B, LIABILITY])

    await expect(getCollateralApySnapshot(position, liabilityVault)).resolves.toEqual({
      supplyUsd: 0,
      weightedSupplyApy: null,
      weightedBaseSupplyApy: null,
      weightedIntrinsicSupplyApy: null,
      weightedSupplyRewardApy: null,
      collateralAddresses: [],
      entries: [],
      liabilityProjectedRates: null,
      isComplete: false,
    })
    expect(getCollateralUsdValue).not.toHaveBeenCalled()
  })

  it('fails closed when an expected vault cannot be resolved', async () => {
    vi.stubGlobal('useVaultRegistry', () => ({
      getOrFetch: vi.fn(async (address: string) => address.toLowerCase() === VAULT_A.toLowerCase() ? vaultA : undefined),
    }))
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    await expect(getCollateralApySnapshot(makePosition(), liabilityVault, {
      deltas: [{ vaultAddress: LIABILITY, assetsDelta: 50n }],
    })).resolves.toEqual({
      supplyUsd: 0,
      weightedSupplyApy: null,
      weightedBaseSupplyApy: null,
      weightedIntrinsicSupplyApy: null,
      weightedSupplyRewardApy: null,
      collateralAddresses: [],
      entries: [],
      liabilityProjectedRates: null,
      isComplete: false,
    })
  })

  it('fails closed when a positive collateral cannot be priced', async () => {
    getCollateralUsdValue.mockImplementationOnce(async (assets: bigint) => Number(assets))
      .mockImplementationOnce(async () => undefined)
    const { getCollateralApySnapshot } = usePositionCollateralApy()

    await expect(getCollateralApySnapshot(makePosition(), liabilityVault)).resolves.toEqual({
      supplyUsd: 0,
      weightedSupplyApy: null,
      weightedBaseSupplyApy: null,
      weightedIntrinsicSupplyApy: null,
      weightedSupplyRewardApy: null,
      collateralAddresses: [],
      entries: [],
      liabilityProjectedRates: null,
      isComplete: false,
    })
  })
})
