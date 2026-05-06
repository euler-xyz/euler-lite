# Vault Labels & Verification

This document explains how euler-lite discovers, categorizes, verifies, and displays vault identity information using the Euler labels system.

## Overview

Not all vaults on-chain are equal. Some are curated by the Euler UI listing process, while others may be unknown or even malicious. The labels system provides a trust layer that maps on-chain vault addresses to off-chain metadata (names, logos, descriptions, deprecation status) and determines whether a vault is **verified** or **unknown**.

## Label Data Sources

Labels originate from the [euler-labels](https://github.com/euler-xyz/euler-labels) GitHub repository by default. The client never fetches label JSON files directly from GitHub/CDN — all label data is served through **server-side proxy endpoints** that add in-memory caching and stale-fallback. Entity logos are still resolved directly from the labels base URL via `<img>` tags (benefiting from browser HTTP caching). Each supported chain has a directory containing JSON files:

| File | Server endpoint | Empty shape |
|------|-----------------|-------------|
| `products.json` | `GET /api/labels/products.json?chainId=X` | `{}` |
| `entities.json` | `GET /api/labels/entities.json?chainId=X` | `{}` |
| `points.json` | `GET /api/labels/points.json?chainId=X` | `[]` |
| `earn-vaults.json` | `GET /api/labels/earn-vaults.json?chainId=X` | `[]` |

All label files are optional — any chain may legitimately ship without a given file. When upstream reports the file absent (HTTP 404 or 403), the proxy returns the type-appropriate empty payload (`{}` for object-shaped files, `[]` for array-shaped files) with HTTP 200 and caches it for 5 minutes. Transient upstream failures (5xx, timeouts) serve stale cached data when available; they do not persist an empty shape into the cache. Non-404 upstream statuses are logged once per refresh so genuine outages stay visible.

Oracle adapter metadata is fetched from a separate repository ([oracle-checks](https://github.com/euler-xyz/oracle-checks)) by default, loaded lazily per adapter via `GET /api/oracle-adapter?chainId=X&address=0x...`.

**Custom sources**: The server resolves upstream URLs from environment variables. `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` overrides the GitHub URL for labels (when set, `NUXT_PUBLIC_CONFIG_LABELS_REPO` and `NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH` are ignored). `NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL` overrides the GitHub URL for oracle checks. The expected URL pattern is `{baseUrl}/{chainId}/{file}` for labels and `{baseUrl}/{chainId}/adapters/{address}.json` for oracle adapters.

**Caching**: The server caches each label response for 5 minutes with in-flight request deduplication, so concurrent cache-miss callers collapse onto a single upstream fetch per `chainId:file`. On upstream failure, stale cached data is served. The client also maintains a 5-minute TTL to avoid unnecessary requests on chain switches. `server/plugins/warm-cache.ts` pre-populates the server caches at Nitro startup (fire-and-forget) and re-warms every 5 minutes.

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
    "isGovernanceLimited": true,                 // If true, shows "Limited risk management" in UI
    "notExplorable": true,                       // If true, hides ALL product vaults from lend/borrow/explore pages
    "block": ["US", "EU"],                       // Country codes/groups to hard-block (see geo-blocking.md)
    "keyring": true,                               // All vaults require Keyring verification (see keyring-hooks.md)
    "recentlyAddedVaults": ["0x1234...abcd"],    // Vault addresses to sort to top in discovery tables
    "vaultOverrides": {                          // Per-vault customizations (see below)
      "0x5678...ef01": {
        "description": "Custom description for this vault",
        "portfolioNotice": "Vault-specific operational notice",
        "deprecationReason": "This specific vault is being phased out",
        "block": ["US", "EU", "CH"],
        "restricted": ["JP"],
        "notExplorableLend": true,
        "notExplorableBorrow": true
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
| `isGovernanceLimited` | `boolean` | No | If `true`, shows "Limited risk management" text under the Risk Manager section on vault overview. The risk manager entity display is also faded to 20% opacity across all UI components (browse lists, vault overview, explore market cards) to visually convey limited active risk management. |
| `notExplorable` | `boolean` | No | If `true`, hides **all** vaults in this product from lend, borrow, and explore discovery pages. Takes precedence over per-vault `notExplorableLend`/`notExplorableBorrow`. Vaults remain accessible via direct URL. |
| `block` | `string[]` | No | Country codes or group aliases (`EU`, `EEA`, `EFTA`) for hard geo-blocking. See [geo-blocking.md](./geo-blocking.md). |
| `recentlyAddedVaults` | `string[]` | No | Subset of `vaults` to sort to the top in discovery tables. |
| `keyring` | `boolean` | No | If `true`, all vaults in this product require Keyring identity verification. See [keyring-hooks.md](./keyring-hooks.md). |
| `vaultOverrides` | `Record<string, VaultOverride>` | No | Per-vault customizations keyed by checksummed address. See next section. |

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
| `keyring` | `boolean` | If `true`, this specific vault requires Keyring identity verification (overrides product-level). See [keyring-hooks.md](./keyring-hooks.md). |

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
    "recentlyAdded": true,                        // Sort to top in earn discovery table
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
| `recentlyAdded` | `boolean` | No | If `true`, sorts vault to top in earn discovery table |
| `deprecated` | `boolean` | No | If `true`, marks vault as deprecated (hidden from discovery, warning banner shown) |
| `deprecationReason` | `string` | No | Explanation shown in deprecation warning banner |
| `description` | `string` | No | Custom description displayed on earn vault items and overview pages |
| `portfolioNotice` | `string` | No | Operational notice shown on portfolio position cards. Supports auto-linked URLs and **bold** formatting. |

---

### Oracle Adapter Files (oracle-checks repo)

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

The `useEulerLabels` composable builds a set of verified vault addresses from the labels data. A vault is considered verified if it appears in any product's `vaults` or `deprecatedVaults` array.

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

**Important: labels remain authoritative for which vaults are _shown_.** SDK categorization says "what category each vault is"; `products.json` / `earn-vaults.json` still say "which vaults to include in lists". The two are composed in `useVaults.loadVaults`: labels select the set, categorization picks the right lens per address.

## Discovery Page Filtering

Labels control which vaults appear on each discovery page:

| Flag | Lend | Borrow | Explore |
|------|------|--------|---------|
| Product `notExplorable: true` | Hidden | Hidden | Hidden |
| Override `notExplorableLend: true` | Hidden | Visible | Visible |
| Override `notExplorableBorrow: true` | Visible | Hidden (both sides) | Visible |
| `deprecatedVaults` | Hidden | Hidden | Visible (dimmed) |
| `recentlyAddedVaults` / `recentlyAdded` | Sorted to top | Sorted to top | Sorted to top |

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

The governor admin must match an address in one of the product's declared entities for the vault to be considered "governor verified". If `isGovernanceLimited` is set, the vault shows "Limited risk management" text and the entity display is faded to 20% opacity across all UI surfaces (list items, overview pages, explore cards).

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

External consumers that only need a yes/no answer for a vault address can call the public [`GET /api/public/is-known`](./public-api.md#get-apipublicis-known) endpoint instead of loading the full label set. The endpoint merges `products.json`, `earn-vaults.json`, and the on-chain `escrowedCollateralPerspective` into a single per-chain verified set, excludes deprecated entries, and answers batches of up to 100 addresses per request.
