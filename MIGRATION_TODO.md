- create robust query keys for query - so that the arguments may differ in unimportant details, see app v3
- cache on server - scripts can reuse?
- port swap service
- port execution service
- intrinsic apy - what to do about it?
- proxy through server? add cache for onchain
- rewards parity and port
- migrate useMarketGroups?
- make sure FE doesn't call any lenses directly
- server side cache
- remove VaultAsset - sdk misses logoURI
- look into security considerations of bigint serializing (loader-serde) comment
- port projected rates to sdk
- utils: position estimates, leverage, discovery calculations
- position.price - what is this calculation doing?
  supplyLiquidationPriceRatio = liabilityValueBorrowing / collateralValueLiquidation
  position.price = currentCollateralPriceUsd * supplyLiquidationPriceRatio
- fallback to onchain?
- publish in github
- deepsec findings
- stop publishing from github?


TO DEVELOP
- tokenlists
- verification



Consider

  3. Vault Category / Source Metadata

  Problem: Lite needs metadata that is not the same as the SDK entity type:

  - Is this a standard EVK or escrow EVK?
  - Did this come from labels, SDK metadata, unresolved collateral discovery, or on-demand fetch?
  - Should it be considered verified for top-level lists?

  That logic currently lives in Lite’s registry: composables/useVaultRegistry.ts:30. The bug we fixed came from mixing fetch success with
  verification in composables/useVaults.ts:148.

  An SDK improvement would be to return/enrich vault metadata alongside fetched entities, something like:

  {
    vault,
    type: VaultType.EVault,
    category: 'standard' | 'escrow',
    source: 'labels' | 'metadata' | 'unresolved-collateral',
  }

  Lite would still decide UI policy, but it would not need to reconstruct category/source state across useVaults, useVaultRegistry, and utils/
  vault/categories.
