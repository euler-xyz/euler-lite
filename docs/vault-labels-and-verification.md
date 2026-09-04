# Vault Labels & Verification

This document explains how euler-lite discovers, categorizes, verifies, and displays vault identity information using the Euler labels system.

## Overview

Not all vaults on-chain are equal. Some are curated by the Euler UI listing process, while others may be unknown or even malicious. The labels system provides a trust layer that maps on-chain vault addresses to off-chain metadata (names, logos, descriptions, deprecation status) and determines whether a vault is **verified** or **unknown**.

## Label Data Sources

Labels originate from the [euler-labels](https://github.com/euler-xyz/euler-labels) GitHub repository by default. The client never fetches label JSON files directly from GitHub/CDN — all label data is served through **server-side proxy endpoints** that add in-memory caching and stale-fallback. Entity logos are still resolved directly from the labels base URL via `<img>` tags (benefiting from browser HTTP caching). Each supported chain has a directory containing JSON files:

| File | Server endpoint | Empty shape |
|------|-----------------|-------------|
| `products.json` | `GET /api/internal/labels/products.json?chainId=X` | `{}` |
| `entities.json` | `GET /api/internal/labels/entities.json?chainId=X` | `{}` |
| `points.json` | `GET /api/internal/labels/points.json?chainId=X` | `[]` |
| `earn-vaults.json` | `GET /api/internal/labels/earn-vaults.json?chainId=X` | `[]` |

All label files are optional — any chain may legitimately ship without a given file. When upstream reports the file absent (HTTP 404 or 403), the proxy returns the type-appropriate empty payload (`{}` for object-shaped files, `[]` for array-shaped files) with HTTP 200 and caches it for 5 minutes. Transient upstream failures (5xx, timeouts) serve stale cached data when available; they do not persist an empty shape into the cache. Non-404 upstream statuses are reported through `reportStatus`, which logs on *transitions* rather than once per refresh: the first observation of a given status warns, an unchanged status stays silent on later refreshes, and a return to `ok` logs a recovery. A persistent outage therefore surfaces once and then goes quiet until it changes.

Oracle adapter identity and health assessments come from Data V3 through the SDK and Lite's same-origin V3 proxy. Detail views load an assessment per adapter; discovery loads the paginated chain catalogue. The UI uses V3's explicit `recognized` identity verdict and server-computed `checksStatus`, preserving `unknown` and `not_applicable` finding outcomes.

**Custom sources**: The server resolves upstream URLs from environment variables. `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` overrides the GitHub URL for labels (when set, `NUXT_PUBLIC_CONFIG_LABELS_REPO` and `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH` are ignored). Oracle assessments use the configured V3 API URL and optional server-side V3 API key.

**Server caching**: The server keeps one 5-minute TTL cache keyed by `chainId:file`, plus an in-flight map so concurrent callers collapse onto a single upstream fetch per key. On upstream failure, stale cached data is served. `server/plugins/warm-cache.ts` pre-populates the cache at Nitro startup (fire-and-forget) and re-warms every 5 minutes.

Two handlers front that one cache, and **they do not read from it the same way**:

| Handler | Used by | Cache behavior |
|---|---|---|
| `/api/internal/labels/{file}?chainId=N` (query-shape) | server-side callers via `labels-helpers.ts` | Reads through. A fresh entry short-circuits and no upstream fetch happens. |
| `/api/internal/labels/{chainId}/{file}` (path-shape) | the SDK — `eulerLabelsBaseUrl` is `/api/internal/labels`, so its default template lands here | Calls `refreshLabelFile` directly, which **bypasses the fresh-entry check**. Every request fetches upstream unless one is already in flight for the same key. |

So the 5-minute TTL is not what bounds upstream traffic on the SDK's path. On that route the cache is used for writes and stale fallback, and the in-flight map is the only thing collapsing duplicate work. Warm callers (`server/plugins/warm-cache.ts` and the vault snapshot builder) call `refreshLabelFile` for the same reason — each cycle rewrites the entry instead of cache-hitting a nearly-expired value. The path handler's file header states this directly, so the two shapes' behavior is documented where it is implemented. See [server-side caching](./server-side-caching.md) for the endpoint-level view.

**Client loading and chain changes**: `useEulerLabels().loadLabels()` loads a snapshot for the current chain. A ready snapshot is reused only while that chain remains selected. On a chain change, the composable publishes an empty snapshot while the new labels load, deduplicates concurrent fetches per `chainId`, and uses a monotonic load generation to prevent a late response from a previous chain or superseded refresh from overwriting current data. ERC-4626 wrap-pair probes use the same chain and generation checks.

The browsing SDK applies a separate 5-minute stale window to its five label queries, so revisiting a chain may reuse SDK-cached data without an upstream request. This cache does not bypass the composable's current-chain publication guard. Call `loadLabels(true)` when an explicit refresh is required; it starts a new composable-level fetch (it does not join `pendingLabelsFetches`) and invalidates all five SDK label queries before calling the SDK. At the transport layer that invalidation does not cancel an already-running `fetchQuery` for the same key — TanStack joins the pending promise — so a force refresh can still receive the older in-flight SDK result. The monotonic load generation still decides which response may publish.

**Address normalization**: All addresses from labels are checksummed via `getAddress()` before storage, ensuring consistent lookups regardless of input casing.

---

## JSON File Schemas

### products.json

Structure: `Record<string, Product>` — keys are product identifiers (e.g. `"euler-flagship"`).

```jsonc
{
  "euler-flagship": {
    // Required fields
    "name": "Euler Flagship",                    // Display name shown in UI
    "description": "The flagship Euler market.",  // Shown on vault overview pages
    "portfolioNotice": "Strategy rebalancing in progress", // Operational notice on portfolio cards (optional)
    "entity": ["euler-foundation"],              // Entity key(s) from entities.json (string or string[])
    "url": "https://euler.finance",              // External link (shown on vault overview)
    "vaults": [                                  // Active vault addresses
      "0x1234...abcd",
      "0x5678...ef01"
    ],

    // Optional fields
    "deprecatedVaults": ["0xold1..."],           // Phased-out vault addresses (still verified, shown as deprecated)
    "deprecationReason": "Migrated to v2",       // Why deprecated — shown in warning banner. Supports URLs.
    "tags": ["keyring", "governance limited"],   // Product classification tags
    "notExplorable": true,                       // If true, hides ALL product vaults from lend/borrow/explore pages
    "block": ["US", "EU"],                       // Country codes/groups to hard-block (see geo-blocking.md)
    "vaultOverrides": {                          // Per-vault customizations (see below)
      "0x5678...ef01": {
        "description": "Custom description for this vault",
        "portfolioNotice": "Vault-specific operational notice",
        "deprecationReason": "This specific vault is being phased out",
        "block": ["US", "EU", "CH"],
        "restricted": ["JP"],
        "notExplorableLend": true,
        "notExplorableBorrow": true,
        "tags": ["recently added"]
      }
    }
  }
}
```

#### Product Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Display name in UI (discovery tables, vault overview, search) |
| `description` | `string` | Yes | Product description shown on vault overview pages. Supports auto-linked URLs. |
| `portfolioNotice` | `string` | No | Operational notice shown on portfolio position cards. Supports auto-linked URLs and **bold** formatting. |
| `entity` | `string \| string[]` | Yes | Key(s) referencing entries in `entities.json`. Used for entity logo display, governor verification, and risk manager identification. |
| `url` | `string` | Yes | External URL linked from entity logos on vault overview pages |
| `vaults` | `string[]` | Yes | Active vault addresses (checksummed). These become "verified" vaults in the app. |
| `deprecatedVaults` | `string[]` | No | Phased-out vault addresses. Still verified and viewable in portfolio, but hidden from discovery tables and shown with a deprecation warning. |
| `deprecationReason` | `string` | No | Explanation for deprecation. Shown in a warning banner on vault overview. URLs are auto-linked. Also accepts legacy key `deprecateReason`. |
| `tags` | `string[]` | No | Product classification tags. `keyring` marks all product vaults as requiring Keyring identity verification; `access control` marks vaults gated by an allowlist hook; `governance limited` shows "Limited risk management" and fades the risk manager entity display; `suppress high utilisation warning` hides the high-utilisation warning while leaving critical utilisation warnings visible; `cyclical note` shows cyclical-note badges, target-utilisation copy, and the cyclical IRM overview. |
| `notExplorable` | `boolean` | No | If `true`, hides **all** vaults in this product from lend, borrow, and explore discovery pages. Takes precedence over per-vault `notExplorableLend`/`notExplorableBorrow`. Vaults remain accessible via direct URL. |
| `block` | `string[]` | No | Country codes or group aliases (`EU`, `EEA`, `EFTA`) for hard geo-blocking. See [geo-blocking.md](./geo-blocking.md). |
| `vaultOverrides` | `Record<string, VaultOverride>` | No | Per-vault customizations keyed by checksummed address. See next section. |

Classification markers use `tags`. Product `isGovernanceLimited`, product `recentlyAddedVaults`, and earn-vault `recentlyAdded` are not supported by the current labels contract.

#### Vault Override Fields

Per-vault overrides allow customizing behavior for individual vaults within a product:

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | Overrides the product `description` for this specific vault on the overview page |
| `portfolioNotice` | `string` | Overrides the product `portfolioNotice` for this specific vault on portfolio cards |
| `deprecationReason` | `string` | Overrides the product `deprecationReason` for this specific vault |
| `block` | `string[]` | **Replaces** (not merges with) the product-level `block` list for this vault |
| `restricted` | `string[]` | Soft geo-restriction for this vault only. No product-level fallback. See [geo-blocking.md](./geo-blocking.md). |
| `notExplorableLend` | `boolean` | If `true`, hides this vault from the **lend** discovery page. Product-level `notExplorable` takes precedence. |
| `notExplorableBorrow` | `boolean` | If `true`, hides this vault from the **borrow** discovery page — both as a borrow vault and as collateral. Product-level `notExplorable` takes precedence. |
| `tags` | `string[]` | Vault classification tags. `keyring`, `access control`, `recently added`, `suppress high utilisation warning`, and `cyclical note` apply to this specific vault. See [keyring-hooks.md](./keyring-hooks.md). |

**Precedence rules**:
- `block`: vault override replaces product-level (not additive)
- `restricted`: vault-level only (no product-level equivalent)
- `notExplorable` (product) > `notExplorableLend` / `notExplorableBorrow` (vault override)
- `description` / `portfolioNotice` / `deprecationReason`: vault override replaces product-level

---

### entities.json

Structure: `Record<string, Entity>` — keys are entity identifiers (e.g. `"euler-foundation"`).

```jsonc
{
  "euler-foundation": {
    "name": "Euler Foundation",                    // Organization name
    "logo": "euler.svg",                           // Logo filename (served from euler-labels repo)
    "description": "The Euler Foundation...",       // Organization description (not currently displayed)
    "url": "https://euler.finance",                // Organization website (linked from vault overview)
    "addresses": {                                 // Map of governance addresses to labels
      "0xGovAddr...": "Governor",
      "0xMultisig...": "Multisig"
    },
    "social": {                                    // Social media links (stored but not currently displayed)
      "twitter": "https://twitter.com/eulerfinance",
      "youtube": "",
      "discord": "https://discord.gg/euler",
      "telegram": "",
      "github": "https://github.com/euler-xyz"
    }
  }
}
```

#### Entity Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Organization name. Shown in Risk Manager section on vault overview and as filter labels on discovery pages. |
| `logo` | `string` | Yes | Logo filename. Resolved to a URL from the euler-labels repo. Displayed as avatar on vault overview and discovery filters. |
| `description` | `string` | Yes | Organization description. *Currently stored but not displayed in the UI.* |
| `url` | `string` | Yes | Organization website. Linked from entity name/logo on vault overview pages. |
| `addresses` | `Record<string, string>` | Yes | Map of checksummed governance addresses to labels. Used to match `vault.governorAdmin` for entity identification and governor verification. |
| `social` | `object` | Yes | Social media links (twitter, youtube, discord, telegram, github). *Currently stored but not displayed in the UI.* |

**Entity matching**: A vault's `governorAdmin` address is compared against all `addresses` keys in entities declared by the product's `entity` field. If matched, the entity is displayed as the vault's Risk Manager.

---

### points.json

**Optional** — if this file is missing, the app functions normally without points/campaign badges.

Structure: `EulerLabelPoint[]` (array of point campaign objects).

```jsonc
[
  {
    "name": "Turtle Club",                        // Campaign name (supports markdown links)
    "logo": "turtle-club.svg",                    // Campaign logo filename
    "collateralVaults": [                         // Vault addresses eligible for this campaign
      "0xVault1...",
      "0xVault2..."
    ]
  }
]
```

#### Points Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Campaign name. Displayed as badge on vault items. Supports markdown link syntax in modals. |
| `logo` | `string` | Yes | Campaign logo filename. Served locally from `/entities/` path with CDN fallback. Displayed as rounded avatar badge. |
| `collateralVaults` | `string[]` | No | Vault addresses eligible for points. Each vault gets a points badge in the UI. |

---

### earn-vaults.json

Structure: `Array<string | EarnVaultEntry>` — each entry is either a plain address string or an object with metadata.

```jsonc
[
  "0xSimpleEarnVault...",                         // Plain address — no special metadata
  {
    "address": "0xDetailedEarnVault...",          // Vault address (required)
    "block": ["US", "EU"],                        // Hard geo-blocking (country codes/groups)
    "restricted": ["JP"],                         // Soft geo-restriction
    "tags": ["recently added"],                   // Sort to top in earn discovery table
    "deprecated": true,                           // Mark as deprecated
    "deprecationReason": "Migrated to new vault", // Deprecation explanation
    "description": "Custom description",          // Vault description
    "portfolioNotice": "Strategy rebalancing in progress"  // Operational notice on portfolio cards
  }
]
```

#### Earn Vault Entry Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `address` | `string` | Yes | Checksummed vault address |
| `block` | `string[]` | No | Country codes/groups for hard geo-blocking (same syntax as products.json `block`) |
| `restricted` | `string[]` | No | Country codes/groups for soft geo-restriction |
| `tags` | `string[]` | No | Earn-vault classification tags. `recently added` sorts the vault to the top in earn discovery. |
| `deprecated` | `boolean` | No | If `true`, marks vault as deprecated (hidden from discovery, warning banner shown) |
| `deprecationReason` | `string` | No | Explanation shown in deprecation warning banner |
| `description` | `string` | No | Custom description displayed on earn vault items and overview pages |
| `portfolioNotice` | `string` | No | Operational notice shown on portfolio position cards. Supports auto-linked URLs and **bold** formatting. |

Classification markers use a clean-cut tags schema. Earn-vault `recentlyAdded` is not supported by the current labels contract.

---

### Oracle Adapter Assessments (Data V3)

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

### Governance hydration guard (SDK 2.0)

SDK 2.0 `EVault` instances always **own** the `governorAdmin` property (the constructor assigns it even when governance was never fetched). An `in`-operator or "property exists" check therefore passes on every real instance and can misread a lazily-hydrated vault as "governance resolved to nothing", producing false **Unknown risk manager** badges in discovery / market graph UI.

Use the value-based guard shared across badge sites:

```ts
hasResolvedGovernorAdmin(vault) // isEVault(vault) && vault.governorAdmin !== undefined
```

Only a **defined** `governorAdmin` means governance actually resolved. Until then, UI must wait (or show a loading/neutral state) rather than treating the vault as unverified.

### Ungoverned vaults

Vaults with `governorAdmin = address(0)` are supported via an **artificial entity** convention: declare an `ungoverned` entity in `entities.json` whose `addresses` map contains the zero address, then list ungoverned vaults under a product that declares `entity: ["ungoverned"]`. The shared governor rule then matches the vault's zero `governorAdmin` against the artificial entity, no special-case code path needed. The UI shows the "Ungoverned" governance type chip independently of entity matching (driven by `governorAdmin === zeroAddress` directly).

This keeps the bridge endpoint verification aligned with the UI: label/entity matching proves the vault is governed by the declared entity, while the "Ungoverned" presentation signal comes directly from the on-chain `governorAdmin` value.

### How `vault.verified` Is Set

| Vault Source | Verification Method |
|-------------|---------------------|
| **EVaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Earn vaults** | Verified if in `earnVaults` from labels (`earn-vaults.json`) |
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

**Important: labels remain authoritative for which vaults are _shown_.** SDK categorization says "what category each vault is"; `products.json` / `earn-vaults.json` still say "which vaults to include in lists". The two are composed in `useVaults.loadVaults`: labels select the set, categorization picks the right lens per address.

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

1. **Labels**: `product.entity` names the owning entity key(s), which are looked up in `entities.json`
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
| `utils/eulerLabelsUtils.ts` | Lookup and helper functions backed by the current SDK label snapshot |
| `composables/useEulerLabels.ts` | SDK-backed label loading and reactive composables |
| `composables/useVaultRegistry.ts` | Vault registry with type detection and unknown resolution |
| `composables/useGeoBlock.ts` | Geo-blocking logic using label block/restricted fields |

## Programmatic verification lookup

External consumers that only need a yes/no answer for a vault address can call the public [`GET /api/public/is-known`](./public-api.md#get-apipublicis-known) endpoint instead of loading the full label set. The endpoint merges `products.json` (active and deprecated entries), `earn-vaults.json` (active and deprecated entries), and the on-chain `escrowedCollateralPerspective` into a single per-chain verified set, applies the same governor / router-governor / owner verification that the client UI uses (an EVK or Securitize vault must have `governorAdmin` — and a non-zero oracle-router governor, if present — match one of its product's declared entity addresses; an Earn vault listed under a product must have `owner` match), and answers batches of up to 100 addresses per request. The same governor check applies to deprecated and active vaults — deprecation does not change the verification rule. Escrow vaults from the on-chain perspective and earn entries with no product entry are trusted unconditionally.

Consumers that need display metadata (resolved name, description, governing entity, asset) on top of the verification verdict can call [`GET /api/public/metadata`](./public-api.md#get-apipublicmetadata), which applies the same labels / override / verification rules the client UI uses and returns a uniform shape across EVK, Securitize, and Earn vaults.
