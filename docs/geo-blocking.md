# Geo-Blocking

This document explains how Euler Lite restricts vault access based on the user's geographic location, covering country detection, blocking rules, per-vault overrides, soft restrictions, and UI enforcement.

## Overview

Certain jurisdictions are prohibited from interacting with specific vaults (or all vaults) due to regulatory requirements. The geo-blocking system:

1. Detects the user's country from an HTTP response header.
2. Evaluates blocking rules at four levels: global sanctions, V3 global/chain rules, product/vault rules, and **asset-level blocks** keyed by the vault's underlying ERC-20.
3. Evaluates soft restriction rules that prevent users from acquiring more exposure to a restricted asset.
4. Extends those rules to the arbitrary-asset selectors used by pay-with (repay), withdraw-to, borrow swap-in, and swap-deposit flows, so a user can't route around a vault block by picking the blocked underlying asset as a swap leg.
5. Prevents blocked users from submitting transactions while still showing blocked vaults in the UI (dimmed, with a "Restricted" chip).

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

The `x-country-code` response header is set by `server/middleware/cors.ts`, which reads the country from the configured edge provider's trusted header via `getEdgeContext` (`server/utils/edge.ts`; header mapping per `EDGE_PROVIDER` preset in `utils/edge-presets.ts`). The edge-set header is protected from client tampering when the origin is reachable only through the edge or origin auth (`EDGE_ORIGIN_SECRET`) is enabled — see the Edge Provider section of `docs/architecture.md`; a caller who reaches an unauthenticated origin directly can still forge vendor headers. Any client-supplied `x-country-code` request header is stripped by `cors.ts` before processing. Under the `none` preset (no edge — forks, previews) the placeholder `--` is emitted so client-side checks don't fail closed.

Detection is cached for 5 minutes to avoid repeated network calls.

```text
Browser → HEAD / → cors.ts strips client x-country-code
                 → getEdgeContext reads the edge country header: DE
                 → sets response x-country-code: DE
        ← x-country-code: DE ← stored as "DE"
```

**Fail-closed**: When country detection is pending, fails, or cannot determine a country, transaction-eligibility checks deny acquisition and swap actions. The UI does not display a misleading "Restricted" badge during the intermediate `undefined` state; it keeps the action disabled as policy-pending.

**Initialization**: `app.vue` calls `useGeoBlock().loadCountry()` on startup. The detected country is stored in a module-level `ref` in `composables/useGeoBlock.ts`:
- `undefined` — not yet loaded (eligibility checks return `true`, fail-closed; presentation suppresses the badge)
- `null` — loaded, country unknown or detection failed (checks return `true`, fail-closed)
- `string` — loaded with a known country code

A concurrency guard (`loadingCountry`) prevents duplicate in-flight requests if `loadCountry()` is called multiple times.

**Local development**: In development (`DOPPLER_ENVIRONMENT=dev`) there is no edge in the request path, so no country header is set. Set `DEV_GEO_COUNTRY=GB` (or any ISO country code) in `.env` to simulate a country for geo-block testing. Without it, the server allows requests through in dev rather than blocking.

## Server-Side Geo-Gate

**File**: `server/middleware/geo-gate.ts`

All API requests first pass through the server-side geo-gate, which applies the same sanctioned-country check at the edge before any client-side logic runs.

The gate reads the country from the edge context (`getEdgeContext`), i.e. from the trusted header of the preset selected by `EDGE_PROVIDER`. Special values such as `XX` (unknown IP) and non-alpha codes (e.g. `T1` for Tor exit nodes) are treated as an undetermined country. If a geo-capable preset leaves the country undetermined **and** the environment is not `dev`, the request is rejected with HTTP 451 (fail-closed). In dev, unknown country is allowed through so local development is not blocked. Under the `none` preset geo-blocking is off (no geo evidence exists by design); production refuses to boot without an explicit `EDGE_PROVIDER`, so this state cannot be reached by mere omission.

```text
Request → cors.ts (strip client x-country-code, set response x-country-code from the edge context)
        → geo-gate.ts (read country from the edge context)
            ├─ country determined → check SANCTIONED_COUNTRIES → block or allow
            └─ country undetermined
                ├─ `none` preset → allow (geo-blocking off)
                ├─ dev env → allow
                └─ otherwise → HTTP 451 (fail-closed)
```

When the gate blocks a request or flags VPN/proxy usage it logs the request path. VPN evidence is audit-only here — it does not fail the request, and it does not replace [address screening](./address-screening.md) at wallet connect. Because some `/api/*` routes embed a wallet address in the path (e.g. `/api/internal/proxy/merkl/users/0x.../rewards`), the path is first run through `safePathTemplate` (`server/utils/observability.ts`), which replaces address and numeric segments with `:address`/`:number` placeholders. This keeps wallet addresses (PII) out of the log sink while preserving the route shape for observability. Routing and matching still operate on the real path.

## Hosted policy evaluation

The SDK paginates live `GET /v3/geo-policies` without a metadata version or chain filter and validates the complete collection. Lite embeds it with the published metadata snapshot. `utils/geo-policies.ts` evaluates `countriesResolved` directly; country groups such as EEA are expanded by V3, including Norway.

Rules accumulate across global, chain, product, vault and asset scopes. A vault rule cannot remove a product restriction. Product matching uses the resolved vault's current `productId`, including vaults outside the discovery allowlist. Non-null chain/product/vault selectors constrain matching; asset address, symbol, name and regex selectors are alternatives. Address and asset text matching is case-insensitive. Standalone asset selectors apply global/chain/asset rules and cannot resolve product or vault scopes.

Regex expressions are compile-checked and limited to 512 characters by the SDK. Lite treats token metadata longer than 128 characters as a match without running its regex. Missing vault asset metadata remains fail-closed. Same-asset and known wrap-pair exemptions apply only to soft asset restrictions, never global/product/vault restrictions, hard blocks, or unavailable policy data.

Sanctions remain in `SANCTIONED_COUNTRIES`, enforced independently at the server edge and in client helpers. The compatibility evaluator and `COUNTRY_GROUPS` remain available for static label data; hosted snapshots always use V3 rules. `LABELS_SOURCE=static` selects the authored-file engine.

## Availability and durable fallback

`server/utils/geo-policy-source.ts` refreshes the full live collection every five minutes, deduplicates concurrent reads, and writes an atomic, upstream-specific checkpoint containing `policies` and `fetchedAt`. A failed or malformed fetch retains last-known-good policies without an age limit and logs their age. A successful empty collection clears previous rules. Partial pagination never replaces the checkpoint.

Set `GEO_POLICY_CACHE_DIR` to a mounted persistent directory to survive container replacement. The default `.data/geo-policies` survives process restarts on the same filesystem. Failed checkpoint writes are logged; current validated live rules remain in use, but that write is not durable. Log monitoring must alert on stale-policy age and checkpoint failures; this code does not provision production alerting.

A cold start with no valid policy snapshot fails the entire labels response. The client distinguishes unavailable policies from an authored empty collection. `useOperationGuard` registers “Compliance data unavailable. Please retry.” for acquisition forms, including direct wallet deposits. Repay and withdrawal forms opt out of this availability blocker. Simple withdrawals/redemptions and repayment without swaps can acknowledge unverified-vault risk when labels are unavailable, in both the form and final reviewed-execution policy. Missing/wrong-chain vault metadata still blocks; swaps, borrowing and mixed acquisition batches still require labels. Country, sanctions and operation-specific checks still apply. Soft restriction helpers also deny acquisition while policies are unavailable, including wrap exemptions.

## Helper functions

- `isVaultBlockedByCountry(address, { asset? })` combines sanctions and matching V3 block policies.
- `isVaultRestrictedByCountry(address, { asset?, counterpart? })` evaluates soft restrictions.
- `isAnyVaultBlockedByCountry` / `isAnyVaultRestrictedByCountry` combine decisions across vaults.
- `isAssetBlockedByCountry` / `isAssetRestrictedByCountry` evaluate standalone asset choices.
- `getVaultTags(address, context)` presents restrictions and deprecation. `swap-target` disables soft-restricted destinations; `supply-source` permits existing exposure to be used for repayment.
- `useGeoBlock().isPolicyAvailable` distinguishes successful empty data from unavailable data.

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

The swap/refinance pages (`/lend/[vault]/swap`, `/position/[number]/borrow/swap`) also skip disabled vaults in their `syncToVault` fallback logic, using `getVaultTags(address, 'swap-target')` to find the first enabled vault.

### Arbitrary-asset selector (`SwapTokenSelector`)

The pay-with / withdraw-to / swap-deposit source / borrow swap-in flows all route through `components/entities/asset/SwapTokenSelector.vue`, which lists tokens from vault assets plus external token lists (Uniswap, DefiLlama, Merkl). Every row is evaluated against `isAssetBlockedByCountry` / `isAssetRestrictedByCountry` (the full asset object is passed, so symbol/name pattern rules fire):

| Picker mode | Hard-block | Soft-restrict |
|---|---|---|
| `'input'` (pay-with, swap-deposit input) | Row disabled, "Restricted" chip | Row enabled, no chip (reducing exposure is allowed) |
| `'output'` (receive-as) | Row disabled, "Restricted" chip | Row disabled, "Restricted" chip (acquiring exposure is disallowed) |

Disabled rows render with `opacity-50 cursor-not-allowed` and suppress the click handler, matching `ChooseCollateralModal`. The custom-token import row (typed-address lookup) runs the same check, so a user who pastes the address of a blocked asset sees the same dimmed + chip state before being able to select it.

A per-render `geoByAddress` map computes the state once per visible row to avoid re-evaluating the helpers on every binding.

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

Uses `useSwapCollateralOptions` with `tagContext: 'supply-source'` so collateral options in the swap-to-repay tab are never disabled by soft restrictions (reducing exposure is always allowed). Cross-position exact-vault sources (`useCrossPositionRepayCollateralOptions`) use the same tag context; they remain Advanced-mode gated and do not add a separate geo rule. See [Cross-Position Repay](./cross-position-repay.md).

### Portfolio Pages

Existing positions in blocked vaults show the "Restricted" chip. No chip for soft-restricted vaults (positions are already open).

## Data flow and validation

V3 live policies → SDK pagination/validation → Lite disk checkpoint → atomic labels bundle → current vault assignments + country → Lite eligibility helpers and operation guards.

The server bundle cache is five minutes; open tabs refresh labels after five minutes, checked once a minute and on focus. Policy updates do not depend on a metadata publication. The labels snapshot revision invalidates asset decision caches.

Tests cover resolved Norway membership, cumulative scopes, product reassignment, chain isolation, case-insensitive asset patterns, input bounds, unavailable versus empty data, acquisition guards, disk restart recovery and malformed/partial fetches. Production canary deployment and alert wiring are separate operational work.
