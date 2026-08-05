# Vault Labels & Verification

This document explains how euler-lite discovers, categorizes, verifies, and displays vault identity information using the Euler labels system.

## Overview

Not all vaults on-chain are equal. Public Labels maps chain-scoped vault addresses to published products, managing entities, display-only co-brands, campaigns, descriptions, tags, and deprecation metadata. Lite combines that published content with on-chain governor checks and its effective visibility data when deciding how a vault is presented.

## Label Data Sources

`useEulerLabels` reads the immutable Public Labels dataset from V3 through the same-origin `/api/internal/v3` proxy. Normal application traffic uses `version=latest`; deterministic tests use the published version pinned in `utils/public-labels.ts`. List reads follow `meta.total` with `limit=100` and increasing `offset`, because V3 caps each page at 100 records.

| Public data | V3 path |
|---|---|
| Vault inventory and labels | `GET /curation/vaults?version=...&chainId=...` |
| Products | `GET /products?version=...&chainId=...` |
| Entities | `GET /entities?version=...` |
| Entity governance addresses | `GET /entities/{entityId}/addresses?chainId=...` |
| Geo policy records | `GET /geo-policies?version=...` |

The vault inventory is a union of label and assessment records. Lite includes a row in label-derived listing or verification state when it has a product/entity assignment or published label content such as display metadata, deprecation, tags, or campaigns. Plain-address labels and assessment-only rows share the same empty content shape, so an empty row is retained only when the SDK compatibility snapshot classifies the same inventory address as a verified or Earn vault. Other assessment-only rows are ignored.

Entity profiles supply hosted logo URLs. A product's `entityId` is its managing entity; `coBrandEntityIds` supplies additional display branding only. Co-brands do not participate in manager ownership, governor verification, or manager-profile market assignment. Neutral escrow inventory rows are not assigned to a product/entity and are not added to the labels-derived verified set.

The current V3 assessment and geo-policy records are not final eligibility decisions. Lite does not use raw `/evk/vaults/{chainId}/{address}/assessment` or `/earn/vaults/{chainId}/{address}/assessment` responses to hide or verify vaults, and it does not resolve global/product/vault/asset geo precedence from raw policy rows. Until V3 publishes an effective derived contract, Lite preserves the effective `block`, `restricted`, and discovery-visibility values supplied by the SDK labels service. Raw geo policies are retained as informational data only.

Oracle adapter metadata is fetched from a separate repository ([oracle-checks](https://github.com/euler-xyz/oracle-checks)) by default, loaded lazily per adapter via `GET /api/internal/oracle-adapter?chainId=X&address=0x...`.

**Caching and fallback**: Public Labels requests share the client label load's chain-scoped in-flight deduplication and refresh lifecycle. The V3 proxy is request-scoped; V3 owns upstream caching. If a Public Labels read fails, the current load falls back to the SDK compatibility-label snapshot and logs the V3 failure.

**Address normalization**: All addresses from labels are checksummed via `getAddress()` before storage, ensuring consistent lookups regardless of input casing.

---

## Published Content Contract

Products provide `entityId`, optional `coBrandEntityIds`, display name, description, URL, portfolio notice, and direct product deprecation metadata. Vault inventory rows provide vault type, product/entity assignment, display metadata, tags, campaigns, and direct vault deprecation metadata. Lite does not cascade product deprecation to a vault; cascading behavior belongs to the future effective derived contract.

Entity rows provide profile text, hosted logos, website/social links, and optional organization details. Lite separately fetches each relevant entity's chain-scoped governance addresses and checksums them before comparison with on-chain governor addresses.

Vault campaigns have a `name`, hosted `logo`, and `type` of `deposit` or `borrow`. Deposit campaigns render beside supply APY and borrow campaigns render beside borrow APY. Campaign badges are informational and do not change reward APR calculations.

Classification markers use vault `tags`. Current UI-recognized tags include `keyring`, `access control`, `governance limited`, `recently added`, `suppress high utilisation warning`, and `cyclical note`.

---

## Oracle Adapter Files (oracle-checks repo)

Oracle adapter metadata is loaded lazily from the [oracle-checks](https://github.com/euler-xyz/oracle-checks) repository. Each adapter has its own file at `data/{chainId}/adapters/{checksummedAddress}.json`.

```jsonc
{
  "oracle": "0xOracleAdapter...",                 // Oracle adapter address
  "base": "0xBaseAsset...",                       // Base asset address
  "quote": "0xQuoteAsset...",                     // Quote asset address
  "name": "Chainlink ETH/USD",                   // Oracle name
  "provider": "Chainlink",                        // Oracle provider (used for logo)
  "methodology": "TWAP 30min",                   // Pricing methodology
  "label": "ETH/USD Feed",                       // Custom label (stored but not displayed)
  "checks": ["heartbeat", "deviation"]            // Security check names (stored but not displayed)
}
```

---

## Vault Verification

### Building the Verified Set

The `useEulerLabels` composable builds a set of verified vault addresses from the labels data: a vault address is added if it appears in any product's `vaults` or `deprecatedVaults` array. This drives the `vault.verified` flag — a precondition for governor verification, but not the full verdict.

The full "is this vault verified?" verdict (used by the UI to render markets, and by the `/api/public/is-known` endpoint) additionally requires the on-chain governor to match a declared entity address. See `utils/vault/governor-verification.ts` for the shared rule, and the "Programmatic verification lookup" section below for the public endpoint.

### Ungoverned vaults

Vaults with `governorAdmin = address(0)` use the `ungoverned` entity whose governance-address set contains the zero address. A product managed by that entity follows the same governor matching rule as any other product. The UI shows the "Ungoverned" governance type chip independently from entity matching, based directly on `governorAdmin === zeroAddress`.

This keeps the bridge endpoint verification aligned with the UI: label/entity matching proves the vault is governed by the declared entity, while the "Ungoverned" presentation signal comes directly from the on-chain `governorAdmin` value.

### How `vault.verified` Is Set

| Vault Source | Verification Method |
|-------------|---------------------|
| **EVaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Earn vaults** | Default repo: loaded from `eulerEarnGovernedPerspective` on-chain. Alternative repos: verified if in `earnVaults` from labels |
| **Escrow vaults** | Loaded from `escrowedCollateralPerspective` on-chain (always verified) |
| **Securitize vaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Unknown vaults** | Resolved via subgraph; verified only if in labels |

### On-Chain Perspectives

Two on-chain perspective contracts provide additional verification:

- **`escrowedCollateralPerspective`**: Lists all verified escrow collateral vaults. Vaults from this perspective are marked `verified: true` and `vaultCategory: 'escrow'`.
- **`eulerEarnGovernedPerspective`**: Lists all governed EulerEarn vaults. Vaults from this perspective are always verified.

## Vault Categories and Types

### Categories

Every EVault belongs to one of two categories:

| Category | Description |
|----------|-------------|
| `'standard'` | Regular lending/borrowing vaults |
| `'escrow'` | Escrow collateral vaults (from escrow perspective) |

### Types

The vault type determines how the vault is fetched and displayed:

| Type | Description |
|------|-------------|
| `'evk'` | Standard Euler Vault Kit vault (lending + borrowing) |
| `'earn'` | EulerEarn aggregator vault (yield optimization) |
| `'securitize'` | Securitize vault (ERC-4626 without borrowing) |

Type is detected through SDK vault metadata and Lite UI categorization helpers in `utils/vault/categories.ts`: `vaultMetaService.fetchVaultType(s)` classifies EVault, EulerEarn, and Securitize vaults, while `eVaultService.fetchVerifiedVaultAddresses(...ESCROW)` provides escrow membership.

### SDK Vault Categorization

The client keeps an in-session categorization cache with this shape:

```ts
{
  evk: string[]        // EVK-family vaults; INCLUDES every escrow address
  earn: string[]       // EulerEarn aggregator vaults
  securitize: string[] // Securitize vaults
  escrow: string[]     // subset of evk from the SDK escrow verified array
}
```

For per-address lookups during direct navigation to a not-yet-cached vault, `fetchVaultCategory(address)` checks the SDK escrow verified array first, then asks `vaultMetaService.fetchVaultType` for the vault type.

**Important: labels remain authoritative for which vaults are _shown_.** SDK categorization says "what category each vault is"; normalized Public Labels products and earn-vault entries say "which vaults to include in lists". The two are composed in `useVaults.loadVaults`: labels select the set, categorization picks the right lens per address.

## Discovery Page Filtering

Labels control which vaults appear on each discovery page:

| Flag | Lend | Borrow | Explore |
|------|------|--------|---------|
| Product `notExplorable: true` | Hidden | Hidden | Hidden |
| Override `notExplorableLend: true` | Hidden | Visible | Visible |
| Override `notExplorableBorrow: true` | Visible | Hidden (both sides) | Visible |
| `deprecatedVaults` | Hidden | Hidden | Visible (dimmed) |
| `recently added` tag | Sorted to top | Sorted to top | Sorted to top |

Product-level `notExplorable` always takes precedence over per-vault overrides. Vaults hidden from discovery are still accessible via direct URL and remain visible in the user's portfolio.

## Unknown Vault Resolution

When a vault address is encountered that isn't in the registry (e.g. from a user's on-chain positions), it goes through resolution:

```
Unknown vault address
       |
       v
  Query subgraph for factory address
       |
       v
  Match factory → type assignment
  (securitize factory → 'securitize',
   earn factory → 'earn',
   otherwise → 'evk')
       |
       v
  Fetch full vault data via appropriate lens
       |
       v
  Check if address is in verified set
       |
       v
  Register in vault registry
```

The `getOrFetch()` method on the vault registry handles this flow. It first checks the in-memory registry, then falls back to on-chain resolution.

## Entity Identification

Entities are matched to vaults through two mechanisms:

1. **Labels**: `product.entity` contains the Public Labels managing entity ID, which is looked up in the normalized entity map
2. **Governor admin**: `vault.governorAdmin` is compared against entity `addresses` keys to identify the governing entity

The governor admin must match an address in one of the product's declared entities for the vault to be considered "governor verified". If the product has the `governance limited` tag, the vault shows "Limited risk management" text and the entity display is faded to 20% opacity across all UI surfaces (list items, overview pages, explore cards).

## Sentinel Address Labels

Vault overview pages display human-readable labels for well-known sentinel addresses instead of raw hex. The `getSpecialAddressLabel()` utility in `utils/special-addresses.ts` maps:

| Address | Label |
|---------|-------|
| `0x0000...0000` | None |
| `0x0000...0348` | USD |
| `0xEeee...eEeE` | ETH |
| `0xbBbB...bBbB` | BTC |

These labels appear in address fields across all vault overview types (EVK, Earn, Securitize) and remain clickable with copy functionality.

## Key Files

| File | Purpose |
|------|---------|
| `entities/euler/labels.ts` | TypeScript type definitions for all label types |
| `utils/public-labels.ts` | Public V3 pagination, normalization, and effective-visibility composition |
| `utils/eulerLabelsUtils.ts` | Lookup and helper functions backed by the normalized label snapshot |
| `composables/useEulerLabels.ts` | Chain-scoped Public Labels and compatibility-visibility loading |
| `composables/useVaultRegistry.ts` | Vault registry with type detection and unknown resolution |
| `composables/useGeoBlock.ts` | Geo-blocking logic using label block/restricted fields |

## Programmatic verification lookup

External consumers that only need a yes/no answer for a vault address can call the public [`GET /api/public/is-known`](./public-api.md#get-apipublicis-known) endpoint instead of loading the full label set. This server endpoint uses the compatibility-label snapshot plus the on-chain `escrowedCollateralPerspective`, applies governor / router-governor / owner verification, and answers batches of up to 100 addresses per request. The same governor check applies to deprecated and active vaults. Escrow vaults from the on-chain perspective and earn entries with no product entry are trusted unconditionally.

Consumers that need display metadata (resolved name, description, governing entity, asset) on top of the verification verdict can call [`GET /api/public/metadata`](./public-api.md#get-apipublicmetadata), which applies the same labels / override / verification rules the client UI uses and returns a uniform shape across EVK, Securitize, and Earn vaults.
