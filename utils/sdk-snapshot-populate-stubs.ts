/**
 * Snapshot-backed stubs for the SDK's populate* surface, used by client-side
 * snapshot hydration (see `composables/useVaults.ts:hydrateFromServer`).
 *
 * The SDK's vault constructors only restore the core data shape from args;
 * the populate-only fields (`marketPriceUsd`, `rewards`, `intrinsicApy`) are
 * written exclusively by `populateMarketPrices` / `populateRewards` /
 * `IntrinsicApyService.populateIntrinsicApy`. Server snapshots ship these
 * values inline but `new EVault(args)` discards them.
 *
 * Mirroring the cross-reference wiring pattern in `sdk-vault-meta-stub.ts`,
 * we build snapshot-backed stubs and let the SDK's own populate paths write
 * the fields onto each vault instance. This keeps the assignment logic
 * (including `populated.X = true` bookkeeping and the EVault collateral
 * marketPrice loop) inside the SDK rather than mirrored in the consumer.
 *
 * Methods not reached by populate paths throw — same loud-failure stance
 * the registry meta-stub takes for unreachable IVaultMetaService methods.
 */
import type {
  ERC4626Vault,
  EVault,
  IIntrinsicApyAdapter,
  IntrinsicApyInfo,
  IPriceService,
  IRewardsService,
  RewardCampaign,
  ServiceResult,
} from '@eulerxyz/euler-v2-sdk'
import { VaultRewardInfo } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'

/**
 * Decoded snapshot args keyed by lowercase vault address. The full args
 * object (NOT a derived subset) is stored so the stubs can read both
 * top-level fields (marketPriceUsd, rewards, intrinsicApy) and nested
 * collateral edges (collaterals[i].marketPriceUsd) without a second pass.
 */
export type SnapshotArgsByAddress = Map<string, Record<string, unknown>>

export const buildSnapshotIndex = (
  entries: Iterable<{ address: string, args: Record<string, unknown> }>,
): SnapshotArgsByAddress => {
  const idx: SnapshotArgsByAddress = new Map()
  for (const { address, args } of entries) {
    idx.set(address.toLowerCase(), args)
  }
  return idx
}

const okResult = <T>(result: T): ServiceResult<T> => ({ result, errors: [] })

const notImplemented = (method: string) => () => {
  throw new Error(
    `snapshot populate stub: ${method}() not supported — this method should not be reached during snapshot hydrate`,
  )
}
type RewardsServiceWithStreamStubs = IRewardsService & Record<
  'fetchRewardStreams' | 'buildRewardStreamClaimPlan',
  ReturnType<typeof notImplemented>
>

/**
 * IPriceService stub. Only the two `*WithDiagnostics` methods exercised by
 * `ERC4626Vault.populateMarketPrices` / `EVault.populateMarketPrices` are
 * implemented; everything else throws. The non-diagnostics variants and
 * oracle methods aren't reached by the populate path.
 */
export const buildSnapshotPriceService = (
  snapshot: SnapshotArgsByAddress,
): IPriceService => ({
  async fetchAssetUsdPriceWithDiagnostics(
    vault: ERC4626Vault,
  ): Promise<ServiceResult<number | undefined>> {
    const args = snapshot.get(vault.address.toLowerCase())
    const price = args?.marketPriceUsd
    return okResult(typeof price === 'number' ? price : undefined)
  },

  async fetchCollateralUsdPriceWithDiagnostics(
    liabilityVault: EVault,
    collateralVault: ERC4626Vault,
  ): Promise<ServiceResult<number | undefined>> {
    const args = snapshot.get(liabilityVault.address.toLowerCase())
    const cols = args?.collaterals as Array<Record<string, unknown>> | undefined
    if (!cols) return okResult(undefined)
    const target = getAddress(collateralVault.address)
    const entry = cols.find((c) => {
      try {
        return getAddress(c.address as Address) === target
      }
      catch {
        return false
      }
    })
    const price = entry?.marketPriceUsd
    return okResult(typeof price === 'number' ? price : undefined)
  },

  getAssetOraclePrice: notImplemented('getAssetOraclePrice'),
  getCollateralShareOraclePrice: notImplemented('getCollateralShareOraclePrice'),
  getCollateralOraclePrice: notImplemented('getCollateralOraclePrice'),
  fetchUnitOfAccountUsdRate: notImplemented('fetchUnitOfAccountUsdRate'),
  fetchUnitOfAccountUsdRateWithDiagnostics: notImplemented('fetchUnitOfAccountUsdRateWithDiagnostics'),
  fetchAssetUsdPrice: notImplemented('fetchAssetUsdPrice'),
  fetchAssetUsdPriceByAddress: notImplemented('fetchAssetUsdPriceByAddress'),
  fetchAssetUsdPriceByAddressWithDiagnostics: notImplemented('fetchAssetUsdPriceByAddressWithDiagnostics'),
  fetchCollateralUsdPrice: notImplemented('fetchCollateralUsdPrice'),
  formatAssetValue: notImplemented('formatAssetValue'),
})

/**
 * IRewardsService stub. Only `fetchVaultRewards` is reached by
 * `ERC4626Vault.populateRewards`; the other methods throw.
 */
export const buildSnapshotRewardsService = (
  snapshot: SnapshotArgsByAddress,
): IRewardsService => ({
  async fetchVaultRewards(
    _chainId: number,
    vaultAddress: Address,
  ): Promise<VaultRewardInfo | undefined> {
    const args = snapshot.get(vaultAddress.toLowerCase())
    // The decoded snapshot is plain JSON ({ campaigns: [...] }) — class
    // methods don't survive serialisation. Rehydrate into a real
    // VaultRewardInfo so consumers can call getActiveCampaigns() etc.
    // (the eligibility predicate is lost on the wire and defaults until
    // the silent RPC refresh replaces this instance).
    const rewards = args?.rewards as { campaigns?: RewardCampaign[] } | undefined
    if (!rewards) return undefined
    if (rewards instanceof VaultRewardInfo) return rewards
    return new VaultRewardInfo({ campaigns: rewards.campaigns ?? [] })
  },

  fetchChainRewards: notImplemented('fetchChainRewards'),
  populateRewards: notImplemented('populateRewards'),
  fetchUserRewards: notImplemented('fetchUserRewards'),
  fetchFuulTotals: notImplemented('fetchFuulTotals'),
  fetchFuulClaimChecks: notImplemented('fetchFuulClaimChecks'),
  fetchRewardStreams: notImplemented('fetchRewardStreams'),
  buildClaimPlan: notImplemented('buildClaimPlan'),
  buildClaimPlans: notImplemented('buildClaimPlans'),
  buildClaimAllPlan: notImplemented('buildClaimAllPlan'),
  buildRewardStreamClaimPlan: notImplemented('buildRewardStreamClaimPlan'),
} as RewardsServiceWithStreamStubs)

/**
 * IIntrinsicApyAdapter stub used by `IntrinsicApyService.populateIntrinsicApy`.
 *
 * The service indexes by asset address (multiple vaults can share an asset),
 * so we collapse the snapshot's per-vault `intrinsicApy` to an asset->apy map.
 * Vaults sharing an asset share an APY value in the upstream service, so
 * keeping the first encounter is correct.
 */
export const buildSnapshotIntrinsicApyAdapter = (
  snapshot: SnapshotArgsByAddress,
): IIntrinsicApyAdapter => {
  const apyByAsset = new Map<string, IntrinsicApyInfo>()
  for (const args of snapshot.values()) {
    const info = args.intrinsicApy as IntrinsicApyInfo | undefined
    if (!info) continue
    const asset = args.asset as { address?: string } | undefined
    const assetAddress = asset?.address?.toLowerCase()
    if (!assetAddress) continue
    if (!apyByAsset.has(assetAddress)) apyByAsset.set(assetAddress, info)
  }

  return {
    async fetchIntrinsicApy(_chainId: number, assetAddress: Address) {
      return apyByAsset.get(assetAddress.toLowerCase())
    },
    async fetchChainIntrinsicApys(_chainId: number, assetAddresses?: Address[]) {
      if (!assetAddresses) return new Map(apyByAsset)
      const out = new Map<string, IntrinsicApyInfo>()
      for (const addr of assetAddresses) {
        const info = apyByAsset.get(addr.toLowerCase())
        if (info) out.set(addr.toLowerCase(), info)
      }
      return out
    },
  }
}
