# Vault Labels & Verification

This document explains how euler-lite discovers, categorizes, verifies, and displays vault identity information using the Euler labels system.

## Overview

Not all vaults on-chain are equal. Public Labels maps chain-scoped vault addresses to published products, managing entities, display-only co-brands, campaigns, descriptions, tags, and deprecation metadata. Lite combines that published content with on-chain governor checks and its effective visibility data when deciding how a vault is presented.

## Label Data Sources

`useEulerLabels` reads one chain-scoped bundle from `/api/internal/public-labels`. The server resolves `version=latest` once through the published-versions endpoint, pins resolved metadata pages and entity profiles to that publication. Geo policies, global entity addresses, platform tags and visibility remain live even for a concrete version. Tests use captured fixtures for those live overlays. List reads follow `meta.total` with `limit=100` and increasing `offset`, because V3 caps each page at 100 records.

| Public data | V3 path |
|---|---|
| Vault inventory and labels | `GET /labels/vaults?view=resolved&version=...&chainId=...` |
| Products | `GET /labels/products?view=resolved&version=...&chainId=...` |
| Entities | `GET /labels/entities?version=...` |
| Entity governance addresses | `GET /labels/entities/{entityId}/addresses` |
| Geo policy records | `GET /geo-policies` |

The adapter also reads `/evk/vaults` and `/earn/vaults` with explicit `visibility=visible,warning,hidden,pending_review`. Trusted label membership requires a visible or warning verdict and a managing entity. Plain-address compatibility entries require a visible or warning verdict as well. Hidden and pending metadata remain available without granting trusted membership. Per-side V3 explorability flags constrain listing; compatibility policy may hide additional vaults but cannot override a negative V3 verdict. On-chain governor checks still determine the stronger verification badge.

Entity profiles supply hosted logo URLs. A product's `entityId` is its managing entity; `coBrandEntityIds` supplies additional display branding only. Co-brands do not participate in manager ownership, governor verification, or manager-profile market assignment. Neutral escrow inventory rows are not assigned to a product/entity and are not added to the labels-derived verified set.

The draft retains the compatibility source for effective `block` and `restricted` rules. Raw live V3 geo policies, including `countriesResolved`, are transported for the hosted enforcement migration but are not yet evaluated by Lite. The compatibility source contributes no display content. Completing hosted geo enforcement, durable last-known-good storage, the static source switch and the bake/cutover remains separate work; this draft is not the complete CTO rollout.

Oracle adapter identity and health assessments come from Data V3 through the SDK and Lite's same-origin V3 proxy. Detail views load an assessment per adapter; discovery loads the paginated chain catalogue. The UI uses V3's explicit `recognized` identity verdict and server-computed `checksStatus`, preserving `unknown` and `not_applicable` finding outcomes.

**Caching and fallback**: The server bundle has a 5-minute chain/version cache, concurrent cold loads share one in-flight fetch, and failures can return a bounded stale bundle. The browser deduplicates chain-scoped loads and rejects superseded responses. An initial failure leaves labels unavailable with a retry action; a failed same-chain refresh retains the last successful snapshot. Retry requests a fresh bundle and reloads vault discovery after labels recover.

**Address normalization**: All addresses from labels are checksummed via `getAddress()` before storage, ensuring consistent lookups regardless of input casing.

---

## Published Content Contract

Products provide `entityId`, optional `coBrandEntityIds`, display name, description, URL, portfolio notice, and direct product deprecation metadata. Vault inventory rows provide vault type, product/entity assignment, display metadata, tags, campaigns, and resolved vault deprecation metadata. V3 resolves the display cascade; Lite preserves empty resolved overrides instead of re-inheriting product notices.

Entity rows provide profile text, hosted logos, website/social links, and optional organization details. Lite separately fetches each relevant entity's global governance addresses and checksums them before comparison with on-chain governor addresses.

Vault campaigns have a `name`, hosted `logo`, and `type` of `deposit` or `borrow`. Deposit campaigns render beside supply APY and borrow campaigns render beside borrow APY. Campaign badges are informational and do not change reward APR calculations.

Classification markers use vault `tags`. Current UI-recognized tags include `keyring`, `access control`, `governance limited`, `recently added`, `suppress high utilisation warning`, and `cyclical note`.

Vault tags stay scoped to their vault override. A product-level tag is emitted only when every assigned vault carries that tag, so one vault's classification cannot leak to sibling vaults.

---

## Oracle Adapter Assessments (Data V3)

How Lite joins these assessments to decoded routes, when it loads the active-route catalogue vs a per-address fallback, and the label/Route/quote rules are in [Oracle Adapter Display](./oracle-adapter-display.md).

Data V3 serves adapter assessments at `/v3/oracles/adapter-assessments` and `/v3/oracles/adapter-assessments/{address}`. Display identity is populated only for recognized adapters. `checksStatus` is a separate health verdict and must not be recomputed from individual findings.

```jsonc
{
  "address": "0xOracleAdapter...",
  "recognized": true,
  "checksStatus": "warning",
  "provider": "Chainlink", // V3 logo key; see below
  "methodology": "Market Price",
  "config": { "base": "0xBaseAsset...", "quote": "0xQuoteAsset..." },
  "findings": [
    { "key": "quote-liveness", "outcome": "unknown", "severity": "medium", "description": "..." }
  ],
  "policyVersion": 3,
  "lastCheckedAt": "2026-09-01T12:01:00.000Z"
}
```

Lite compares the assessed base/quote pair with the decoded route before applying the health verdict. The Checks cell distinguishes three states: recognized adapters show the health verdict and counts; adapters V3 assessed but could not identify show "Unrecognized" with the failing identity rule (`reason`) and expose only the identity findings; adapters with no assessment row show "Not assessed". Rule keys are rendered as sentence-case titles client-side (`formatOracleCheckTitle`).

Router recognition comes from `/v3/oracles/routers`, which lists exactly the routers deployed by the recognized `EulerRouterFactory`; the indexer only tracks factory deployments.

#### Oracle provider logos

Explore and vault oracle rows resolve logos through `getOracleProviderLogo` (`entities/oracle-providers.ts`), not local SVG assets.

The URL is always `https://v3.euler.finance/v3/images/oracle-providers/{key}`. That host is `DEFAULT_V3_API_URL`; it does **not** follow `V3_API_URL` / `EULER_SDK_V3_API_URL`. Custom V3 deployments still load logos from production V3. `img-src` already allows `https:` (see [Token List](./token-list.md#csp)).

Lookup rules:

1. If `meta.provider` is present, map **only** that string. Do not fall through to the adapter name. A Midas vault priced by `ChainlinkOracle` must show the Midas logo, not Chainlink.
2. If provider is missing, map `meta.name` / the adapter type name (`ChainlinkOracle`, `PythOracle`, `UniswapV3Oracle`, …).
3. Unknown identifiers return `undefined` — the UI renders without a logo rather than guessing.

`utils/oracle-adapter-views.ts` assigns `view.logo` from those two fields when it builds the shared adapter view used by the borrow-page Oracles block and the Explore matrix.

---

## Vault Verification

### Building the Verified Set

The `useEulerLabels` composable builds a set of verified vault addresses from the labels data: a vault address is added if it appears in any product's `vaults` or `deprecatedVaults` array. This drives the `vault.verified` flag — a precondition for governor verification, but not the full verdict.

The full "is this vault verified?" verdict (used by the UI to render markets, and by the `/api/public/is-known` endpoint) additionally requires the on-chain governor to match a declared entity address. See `utils/vault/governor-verification.ts` for the shared rule, and the "Programmatic verification lookup" section below for the public endpoint.

### Operation warnings and consent

Operation guards verify vaults against the app's selected chain and the shared governor/owner rules. Wallet connection and chain switching remain available before other form gates. While labels or vault metadata are unresolved, operations remain blocked with a loading state or a retry action.

The Earn deposit page opens its automatic disclaimer only for a resolved unverified vault when the wallet is connected to the selected chain. Clicking Yes dismisses the browsing notice. The form's explicit risk button records the account, chain, operation, and vault-set acknowledgment required by final execution policy. The popup closes when acknowledgment is no longer required or the page unmounts. Final execution policy also requires available verification labels for operations involving vaults.

### Governance hydration guard (SDK 2.0)

SDK 2.0 `EVault` instances always **own** the `governorAdmin` property (the constructor assigns it even when governance was never fetched). An `in`-operator or "property exists" check therefore passes on every real instance and can misread a lazily-hydrated vault as "governance resolved to nothing", producing false **Unknown risk manager** badges in discovery / market graph UI.

Use the value-based guard shared across badge sites:

```ts
hasResolvedGovernorAdmin(vault) // isEVault(vault) && vault.governorAdmin !== undefined
```

Only a **defined** `governorAdmin` means governance actually resolved. Until then, UI must wait (or show a loading/neutral state) rather than treating the vault as unverified.

### Ungoverned vaults

Vaults with `governorAdmin = address(0)` use the `ungoverned` entity whose governance-address set contains the zero address. A product managed by that entity follows the same governor matching rule as any other product. The UI shows the "Ungoverned" governance type chip independently from entity matching, based directly on `governorAdmin === zeroAddress`.

This keeps the bridge endpoint verification aligned with the UI: label/entity matching proves the vault is governed by the declared entity, while the "Ungoverned" presentation signal comes directly from the on-chain `governorAdmin` value.

### How `vault.verified` Is Set

| Vault Source | Verification Method |
|-------------|---------------------|
| **EVaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Earn vaults** | Verified if present in the normalized Public Labels `earnVaults` set |
| **Escrow vaults** | Loaded from `escrowedCollateralPerspective` on-chain (always verified) |
| **Securitize vaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Unknown vaults** | Resolved via subgraph; verified only if in labels |

### On-Chain Perspectives

One on-chain perspective contract provides additional verification:

- **`escrowedCollateralPerspective`**: Lists all verified escrow collateral vaults. Vaults from this perspective are marked `verified: true` and `vaultCategory: 'escrow'`.

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
| Override `notExplorableLend: true` | Hidden | Visible | Visible* |
| Override `notExplorableBorrow: true` | Visible | Hidden (both sides) | Visible* |
| `deprecatedVaults` | Hidden | Hidden | Visible (dimmed) |
| `recently added` tag | Sorted to top | Sorted to top | Sorted to top |

*Explore lists a product only while it has an explorable market side: at least one member vault that is open on the lend side, or borrowable (including residual debt) and open on the borrow side. A collateral-only product — every member flagged `notExplorableLend` and not borrowable, e.g. issuer-governed Securitize collateral wrappers — gets no Explore card. Its vaults still render as external collateral in other markets' graphs, and its direct market URL still resolves on demand (members are satisfied from the vault registry first, so non-EVault members load correctly).

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
| `server/utils/public-labels-source.ts` | Shared V3 aggregate cache used by browser, public APIs, and vault snapshots |
| `server/utils/labels-source.ts` | Server-only temporary effective-policy overlay |
| `composables/useEulerLabels.ts` | Chain-scoped aggregate loading and normalized label publication |
| `composables/useVaultRegistry.ts` | Vault registry with type detection and unknown resolution |
| `composables/useGeoBlock.ts` | Geo-blocking logic using label block/restricted fields |

## Programmatic verification lookup

External consumers that only need a yes/no answer for a vault address can call the public [`GET /api/public/is-known`](./public-api.md#get-apipublicis-known) endpoint instead of loading the full label set. This server endpoint uses the same normalized Public Labels bundle as the UI plus the on-chain `escrowedCollateralPerspective`, applies governor / router-governor / owner verification, and answers batches of up to 100 addresses per request. The same governor check applies to deprecated and active vaults. Escrow vaults from the on-chain perspective and standalone Earn entries are trusted unconditionally.

Consumers that need display metadata (resolved name, description, governing entity, asset) on top of the verification verdict can call [`GET /api/public/metadata`](./public-api.md#get-apipublicmetadata), which applies the same labels / override / verification rules the client UI uses and returns a uniform shape across EVK, Securitize, and Earn vaults.
