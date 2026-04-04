# Geo-Blocking

This document explains how Euler Lite restricts vault access based on the user's geographic location, covering country detection, blocking rules, per-vault overrides, soft restrictions, and UI enforcement.

## Overview

Certain jurisdictions are prohibited from interacting with specific vaults (or all vaults) due to regulatory requirements. The geo-blocking system:

1. Detects the user's country from an HTTP response header.
2. Evaluates blocking rules at three levels: global sanctions, product-level blocks, and per-vault overrides.
3. Evaluates soft restriction rules that prevent users from acquiring more exposure to a restricted asset.
4. Prevents blocked users from submitting transactions while still showing blocked vaults in the UI (dimmed, with a "Restricted" chip).

Users with existing lending deposits in newly-blocked vaults can still view and withdraw. For borrow positions where any vault (collateral or borrow) is blocked, only repay is possible — supply, withdraw, and all other operations are disabled.

## Blocked vs Restricted

The system distinguishes two levels of geographic restriction:

### Blocked (Hard Block)

A vault that is **blocked** for the user's country prevents **all** new operations. The UI shows opacity dimming and a "Restricted" chip on all browse pages.

- **Lending deposits** (`/lend/[vault]`): withdraw is always allowed (no geo check on the withdraw page). Supply is blocked.
- **Borrow positions** (`/position/[number]`): the geo check uses `isAnyVaultBlockedByCountry` across **all** vaults in the position (borrow + collaterals). If any vault is blocked, only **Repay** remains enabled — Supply, Withdraw, Multiply, Borrow, Collateral Swap, and Debt Swap are all disabled.

### Restricted (Soft Block)

A vault that is **restricted** for the user's country prevents the user from **acquiring more exposure** to the asset and from **performing any swap involving the asset**. Operations that use assets already in the user's wallet without swapping, or that reduce exposure without swapping, remain allowed.

| Action | Blocked (lending deposit) | Blocked (borrow position) | Restricted |
|--------|--------------------------|---------------------------|------------|
| Supply from wallet (no swap) | NO | NO | YES |
| Supply via swap (swap + deposit) | NO | NO | **NO** |
| Earn deposit from wallet | NO | NO | YES |
| Withdraw to underlying (no swap) | YES | NO | YES |
| Withdraw via swap (withdraw + swap) | — | NO | **NO** |
| Repay | — | YES | YES |
| Borrow from this vault | NO | NO | **NO** |
| Multiply (as long or short) | NO | NO | **NO** |
| Swap + deposit + borrow (collateral vault restricted) | NO | NO | **NO** |
| Swap collateral/debt TO this vault | NO | NO | **NO** |
| Swap collateral/debt FROM this vault | NO | NO | **NO** |

When both collateral AND borrow vault in a pair are restricted, the pair is treated as **effectively blocked** — identical to a hard block in the UI. On the borrow browse page this means opacity dimming + "Restricted" chip. On the position overview, all buttons except Repay are disabled and the same "Region restricted" toast is shown as for hard-blocked positions.

## Country Detection

**File**: `services/country.ts`

The user's country is detected by sending a `HEAD` request to the application's origin and reading the `x-country-code` response header. The result is normalized to uppercase ISO 3166-1 alpha-2 (e.g. `US`, `DE`, `GB`).

The `x-country-code` response header is set by `server/middleware/cors.ts`, which reads Cloudflare's `CF-IPCountry` edge header (immutably set by Cloudflare's network). Any client-supplied `x-country-code` request header is stripped by `cors.ts` before processing, preventing bypass.

Detection is cached for 5 minutes to avoid repeated network calls.

```
Browser → HEAD / → cors.ts strips client x-country-code
                 → reads CF-IPCountry: DE
                 → sets response x-country-code: DE
        ← x-country-code: DE ← stored as "DE"
```

**Fail-closed**: When country detection fails or the country cannot be determined, the detected country is stored as `null`. All blocking and restriction checks treat `null` as blocked (fail-closed). Only the intermediate loading state (`undefined`, before the initial HEAD request completes) leaves checks permissive.

**Initialization**: `app.vue` calls `useGeoBlock().loadCountry()` on startup. The detected country is stored in a module-level `ref` in `composables/useGeoBlock.ts`:
- `undefined` — not yet loaded (checks return `false`, permissive during initial load)
- `null` — loaded, country unknown or detection failed (checks return `true`, fail-closed)
- `string` — loaded with a known country code

A concurrency guard (`loadingCountry`) prevents duplicate in-flight requests if `loadCountry()` is called multiple times.

**Local development**: In development (`DOPPLER_ENVIRONMENT=dev`), Cloudflare is not in the request path so `CF-IPCountry` is never set. Set `DEV_GEO_COUNTRY=GB` (or any ISO country code) in `.env` to simulate a country for geo-block testing. Without it, the server allows requests through in dev rather than blocking.

## Server-Side Geo-Gate

**File**: `server/middleware/geo-gate.ts`

All API requests first pass through the server-side geo-gate, which applies the same sanctioned-country check at the edge before any client-side logic runs.

The gate reads `CF-IPCountry` from the Cloudflare edge header. Special values `XX` (unknown IP) and `T1` (Tor exit node) are treated as an undetermined country. If the country cannot be determined **and** the environment is not `dev`, the request is rejected with HTTP 451 (fail-closed). In dev, unknown country is allowed through so local development is not blocked.

```
Request → cors.ts (strip client x-country-code, set response x-country-code from CF-IPCountry)
        → geo-gate.ts (read CF-IPCountry)
            ├─ country determined → check SANCTIONED_COUNTRIES → block or allow
            └─ country undetermined
                ├─ dev env → allow
                └─ prod env → HTTP 451 (fail-closed)
```

## Blocking Rules

**File**: `composables/useGeoBlock.ts`

The function `isVaultBlockedByCountry(vaultAddress)` evaluates three layers in order:

### 1. Sanctioned Countries (Global Block)

Defined in `entities/constants.ts` as `SANCTIONED_COUNTRIES`. Users from these countries are blocked from **all** vaults unconditionally:

```
AF, CF, CU, KP, CD, ET, IR, IQ, LB, LY, ML, MM, NI, RU, SO, SS, SD, SY, VE, YE, ZW
```

This list is checked first. If the user's country matches, the function returns `true` immediately without checking product or vault-level blocks.

### 2. Product-Level Blocks

Each product in `products.json` (from the euler-labels repo) can have a `block` array of country codes or group aliases:

```json
{
  "name": "Example Vault",
  "vaults": ["0x1234..."],
  "block": ["US", "EU"]
}
```

All vaults listed under that product inherit the block list. The function `getVaultBlock(address)` in `useEulerLabels.ts` resolves this.

### 3. Per-Vault Overrides

A product can override blocking rules for individual vaults via `vaultOverrides`:

```json
{
  "name": "Example Product",
  "vaults": ["0xAAA...", "0xBBB..."],
  "block": ["US"],
  "vaultOverrides": {
    "0xBBB...": {
      "block": ["US", "EU", "CH"]
    }
  }
}
```

When a vault has an override with a `block` field, the override **replaces** (not merges with) the product-level block list. In the example above, `0xAAA` is blocked for `US` only, while `0xBBB` is blocked for `US`, `EU`, and `CH`.

### 4. Earn Vault Blocks

Earn vaults have a separate blocking mechanism in `earn-vaults.json`. Entries can be a plain address string (no blocking) or an object with a `block` array:

```json
[
  "0x1111...",
  { "address": "0x2222...", "block": ["EU", "CH"] }
]
```

These are stored in a dedicated `earnVaultBlocks` map (keyed by lowercase address) and checked by `getEarnVaultBlock(address)`.

## Restriction Rules (Soft Block)

**File**: `composables/useGeoBlock.ts`

The function `isVaultRestrictedByCountry(vaultAddress)` checks for soft restrictions:

### Per-Vault Override Restrictions

A product can specify `restricted` in vault overrides (vault-level only, no product-level fallback):

```json
{
  "name": "Example Product",
  "vaults": ["0xAAA...", "0xBBB..."],
  "vaultOverrides": {
    "0xBBB...": {
      "restricted": ["US", "EU"]
    }
  }
}
```

### Earn Vault Restrictions

Earn vault entries in `earn-vaults.json` can also have a `restricted` array:

```json
[
  "0x1111...",
  { "address": "0x2222...", "restricted": ["US"], "block": ["IR"] }
]
```

A vault can have both `block` and `restricted`. The `block` check takes precedence — if a vault is blocked, the restricted check is not evaluated (blocked is stricter).

## Country Groups

**File**: `entities/constants.ts`

Block and restriction lists can reference group aliases instead of individual country codes. The `expandBlockList()` function in `useGeoBlock.ts` resolves these before matching:

| Alias | Expansion | Count |
|-------|-----------|-------|
| `EU` | All 27 EU member states (AT, BE, BG, HR, CY, CZ, DK, EE, FI, FR, DE, GR, HU, IE, IT, LV, LT, LU, MT, NL, PL, PT, RO, SK, SI, ES, SE) | 27 |
| `EEA` | EU + IS, LI, NO | 30 |
| `EFTA` | IS, LI, NO, CH | 4 |

Group aliases can be mixed with individual codes: `["EU", "CH", "US"]` blocks all EU countries plus Switzerland and the US.

## Helper Functions

### `isVaultBlockedByCountry(address): boolean`

The core hard-block check. Returns `true` if the vault is blocked for the detected country.

### `isAnyVaultBlockedByCountry(...addresses): boolean`

Returns `true` if **any** of the provided vault addresses are blocked. Used on action pages that involve multiple vaults (e.g. a borrow position has both a collateral vault and a borrow vault).

### `isVaultRestrictedByCountry(address): boolean`

The soft-restriction check. Returns `true` if the vault has a `restricted` entry matching the user's country. Only checks vault-level overrides and earn vault restrictions (no product-level fallback).

### `isAnyVaultRestrictedByCountry(...addresses): boolean`

Returns `true` if **any** of the provided vault addresses are restricted. Used for multi-vault restriction checks (e.g. multiply requires checking both long and short vaults).

### `getVaultTags(address, context?): { tags: string[], disabled: boolean }`

Combines geo-blocking, soft-restriction, and deprecation status into a single result for UI consumption. Returns tags like `["Restricted"]`, `["Deprecated"]`, or `["Restricted", "Deprecated"]`.

The `context` parameter controls when the "Restricted" chip appears for soft-restricted vaults:

| Context | When Used | Shows Restricted Chip? |
|---------|-----------|----------------------|
| `'browse'` (default) | Browse pages, general display | Only for hard-blocked vaults |
| `'swap-target'` | Vault selection modals for swap/borrow TO targets | Yes (prevents acquiring exposure) |
| `'supply-source'` | Vault selection modals for supply FROM sources, multiply collateral | No (user is spending, not acquiring) |

## UI Enforcement

The geo-block and restriction status surfaces in multiple layers of the UI:

### Browse Pages (`/lend`, `/earn`, `/borrow`)

**Lend/Earn tables**: No chip for soft-restricted vaults (supply/deposit from wallet is always allowed).

**Borrow table** (`VaultBorrowItem.vue`):
- If borrow vault is restricted: "Restricted" chip, no opacity dimming
- If BOTH borrow and collateral vaults are restricted: "Restricted" chip + `opacity-50` (effectively blocked — no useful action possible)
- If hard-blocked: "Restricted" chip + `opacity-50` (existing behavior)

### Vault Detail Pages (`/lend/[vault]`, `/earn/[vault]`)

A warning toast is displayed at the top of the page when hard-blocked. No changes for soft-restricted (supply from wallet is always allowed).

### Selection Modals (`ChooseCollateralModal`)

When swapping collateral or debt, blocked/deprecated vaults appear in the selection list with:
- `opacity-50` and `cursor-not-allowed` styling
- Warning chips ("Restricted", "Deprecated") matching the browse page styling
- Click handler disabled — the user cannot select them

For soft-restricted vaults, the behavior depends on the context:
- **Swap TO** (`tagContext: 'swap-target'`): Shows "Restricted" chip, disabled (prevents acquiring more exposure)
- **Supply FROM** (`tagContext: 'supply-source'`): No chip, enabled (user is spending, not acquiring)
- **Repay via collateral swap**: Uses `supply-source` context — collateral options are always selectable

**Default selection**: `AssetInput.vue` watches the collateral options list and auto-advances past disabled options. If the first option is blocked/restricted/deprecated, the first enabled option is selected instead. This prevents a disabled vault from being pre-selected when a modal opens or a page loads.

The three swap pages (`/lend/[vault]/swap`, `/position/[number]/collateral/swap`, `/position/[number]/borrow/swap`) also skip disabled vaults in their `syncToVault` fallback logic, using `getVaultTags(address, 'swap-target')` to find the first enabled vault.

### Action Pages

#### Borrow Page (`/borrow/[collateral]/[borrow]`)

Separate restriction checks for borrow and multiply tabs:
- `isBorrowRestricted`: borrow vault restricted → borrow tab disabled
- `isMultiplyRestricted`: either vault restricted → multiply tab disabled
- `isPairFullyRestricted`: both vaults restricted → "Region restricted" toast on both tabs (same as hard block)
- Both have submit guards and warning toasts

#### Position Borrow Page (`/position/[number]/borrow`)

- `isBorrowRestricted`: borrow vault restricted → submit disabled with warning toast

#### Position Multiply Page (`/position/[number]/multiply`)

- `isMultiplyRestricted`: either long or short vault restricted → submit disabled with warning toast

#### Position Overview (`/position/[number]`)

Per-button restriction gating when **one** vault is restricted:
- **Multiply** button: disabled if `isMultiplyRestricted` (either vault restricted)
- **Borrow More** button: disabled if `isBorrowRestricted` (borrow vault restricted)
- **Supply, Withdraw, Repay, Collateral Swap, Debt Swap**: NO changes (always allowed)
- A softer "Asset restricted" warning toast appears

When **both** vaults are restricted (`isPairFullyRestricted`), the pair is treated identically to a hard block:
- **Repay**: only enabled button
- **Multiply, Borrow, Supply, Withdraw, Collateral Swap, Debt Swap**: all disabled
- Same "Region restricted" toast as hard-blocked positions

#### Repay Page (`/position/[number]/repay`)

Uses `useSwapCollateralOptions` with `tagContext: 'supply-source'` so collateral options in the swap-to-repay tab are never disabled by soft restrictions (reducing exposure is always allowed).

### Portfolio Pages

Existing positions in blocked vaults show the "Restricted" chip. No chip for soft-restricted vaults (positions are already open).

## Data Flow

```
App Startup
  │
  ├─ loadCountry() ─► HEAD / ─► cors.ts sets x-country-code from CF-IPCountry
  │                  ◄─────────── x-country-code: DE ──────────────────────────
  │                  country ref: "DE" (5-min cache)
  │                  undefined → null (fail-closed) on unknown/error
  │
  └─ loadLabels() ──► euler-labels data source (GitHub or S3/CDN) ─► products.json ─► product.block
                                                                    product.vaultOverrides[addr].block
                                                                    product.vaultOverrides[addr].restricted
                                                 ► earn-vaults.json ─► earnVaultBlocks map
                                                                       earnVaultRestrictions map
                                                   (5-min cache)

Server-Side (every API request):
  geo-gate.ts reads CF-IPCountry
  ├─ unknown/XX/T1 + prod → HTTP 451 (fail-closed)
  ├─ unknown + dev → allow
  └─ known country → check SANCTIONED_COUNTRIES → block or allow

Runtime Check: isVaultBlockedByCountry("0x1234...")
  │
  ├─ country === undefined (loading) → false (permissive)
  ├─ country === null (unknown, fail-closed) → true (blocked)
  │
  ├─ 1. SANCTIONED_COUNTRIES includes "DE"?  ─► yes → blocked
  │
  ├─ 2. getVaultBlock("0x1234...")
  │     └─ product.vaultOverrides["0x1234..."]?.block ?? product.block
  │     └─ expandBlockList(codes) → includes "DE"?  ─► yes → blocked
  │
  ├─ 3. getEarnVaultBlock("0x1234...")
  │     └─ earnVaultBlocks[lowercase addr]
  │     └─ expandBlockList(codes) → includes "DE"?  ─► yes → blocked
  │
  └─ 4. Not blocked → return false

Runtime Check: isVaultRestrictedByCountry("0x1234...")
  │
  ├─ country === undefined (loading) → false (permissive)
  ├─ country === null (unknown, fail-closed) → true (restricted)
  │
  ├─ 1. getVaultRestricted("0x1234...")
  │     └─ product.vaultOverrides["0x1234..."]?.restricted (no product fallback)
  │     └─ expandBlockList(codes) → includes "DE"?  ─► yes → restricted
  │
  ├─ 2. getEarnVaultRestricted("0x1234...")
  │     └─ earnVaultRestrictions[lowercase addr]
  │     └─ expandBlockList(codes) → includes "DE"?  ─► yes → restricted
  │
  └─ 3. Not restricted → return false
```

## Configuration

All blocking and restriction configuration lives outside the app codebase:

| What | Where | Effect |
|------|-------|--------|
| Global sanctions list | `entities/constants.ts` — `SANCTIONED_COUNTRIES` | Blocks all vaults for listed countries |
| Country group definitions | `entities/constants.ts` — `COUNTRY_GROUPS` | Defines EU, EEA, EFTA aliases |
| Product-level blocks | `euler-labels` repo — `products.json` `block` field | Blocks all vaults in a product |
| Per-vault block overrides | `euler-labels` repo — `products.json` `vaultOverrides[addr].block` | Overrides product block for one vault |
| Per-vault restrictions | `euler-labels` repo — `products.json` `vaultOverrides[addr].restricted` | Soft-restricts one vault (no product fallback) |
| Earn vault blocks | `euler-labels` repo — `earn-vaults.json` `block` field | Hard-blocks specific earn vaults |
| Earn vault restrictions | `euler-labels` repo — `earn-vaults.json` `restricted` field | Soft-restricts specific earn vaults |
| Dev country simulation | `.env` — `DEV_GEO_COUNTRY=GB` | Simulates a country in dev (no effect outside dev) |

Changes to `products.json` or `earn-vaults.json` in the euler-labels data source (GitHub repo or S3/CDN) take effect within 5 minutes (the label cache TTL) without any app deployment.

## Key Files

| File | Role |
|------|------|
| `services/country.ts` | Client-side country detection via HEAD request and `x-country-code` response header |
| `server/middleware/cors.ts` | Strips client `x-country-code`, derives authoritative value from `CF-IPCountry`, emits as response header |
| `server/middleware/geo-gate.ts` | Server-side sanctioned-country block; fail-closed on unknown country in prod |
| `composables/useGeoBlock.ts` | Core blocking logic, `isVaultBlockedByCountry`, `isVaultRestrictedByCountry`, `getVaultTags` |
| `composables/useEulerLabels.ts` | Label fetching, `getVaultBlock`, `getEarnVaultBlock`, `getVaultRestricted`, `getEarnVaultRestricted` |
| `entities/constants.ts` | `SANCTIONED_COUNTRIES`, `COUNTRY_GROUPS` (EU/EEA/EFTA) |
| `entities/euler/labels.ts` | TypeScript types (`EulerLabelProduct`, `EulerLabelVaultOverride` with `restricted`) |
| `components/entities/vault/VaultItem.vue` | Browse page "Restricted" chip (hard-block only) |
| `components/entities/vault/VaultBorrowItem.vue` | Borrow browse page "Restricted" chip (hard-block + soft-restricted) |
| `components/entities/vault/ChooseCollateralModal.vue` | Selection modal disabled state and warning chips |
| `composables/useSwapCollateralOptions.ts` | Collateral selection with `tagContext` parameter |
| `composables/useSwapDebtOptions.ts` | Debt selection with `'swap-target'` context |
| `composables/useMultiplyCollateralOptions.ts` | Multiply collateral selection with `'supply-source'` context |
