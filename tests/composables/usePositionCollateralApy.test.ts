import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { usePositionCollateralApy } from '~/composables/usePositionCollateralApy'

const { getProjectedRatesBatch, getCollateralUsdValueOrZero } = vi.hoisted(() => ({
  getProjectedRatesBatch: vi.fn(async (requests: unknown[]) => requests.map(() => ({
    supplyAPY: 8n * 10n ** 25n,
    borrowAPY: 0n,
  }))),
  getCollateralUsdValueOrZero: vi.fn(async (assets: bigint) => Number(assets)),
}))

vi.mock('~/utils/vault/apy', () => ({ getProjectedRatesBatch }))
vi.mock('~/utils/sdk-prices', () => ({ getCollateralUsdValueOrZero }))
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
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useRewardsApy', () => ({
      version: ref(1),
      getSupplyRewardApy: vi.fn(() => 1),
    }))
    vi.stubGlobal('useVaultRegistry', () => ({
      getOrFetch: vi.fn(async (address: string) => ({
        [VAULT_A.toLowerCase()]: vaultA,
        [VAULT_B.toLowerCase()]: vaultB,
      })[address.toLowerCase()]),
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
    expect(snapshot.collateralAddresses).toEqual([VAULT_A, VAULT_B])
  })

  it('fails closed when an expected collateral position is unresolved', async () => {
    const { getCollateralApySnapshot } = usePositionCollateralApy()
    const position = makePosition([VAULT_A, VAULT_B, LIABILITY])

    await expect(getCollateralApySnapshot(position, liabilityVault)).resolves.toEqual({
      supplyUsd: 0,
      weightedSupplyApy: null,
      collateralAddresses: [],
    })
    expect(getCollateralUsdValueOrZero).not.toHaveBeenCalled()
  })
})
