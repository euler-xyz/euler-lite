# Vault Labels & Verification

This document explains how euler-lite discovers, categorizes, verifies, and displays vault identity information using the Euler labels system.

## Overview

Not all vaults on-chain are equal. Public Labels maps chain-scoped vault addresses to published products, managing entities, display-only co-brands, campaigns, descriptions, tags, and deprecation metadata. On V3-assessed chains, Lite uses the effective visibility verdict for verification. Metadata-only and static sources use local governor or owner checks.

## Label Data Sources

`useEulerLabels` reads one chain-scoped bundle from `/api/internal/public-labels`. The server resolves `version=latest` once through the published-versions endpoint, pins resolved metadata pages and entity profiles to that publication. Geo policies, global entity addresses, platform tags and visibility remain live even for a concrete version. Tests use captured fixtures for those live overlays. List reads follow `meta.total` with `limit=100` and increasing `offset`, because V3 caps each page at 100 records.

SDK label population in Lite uses the same public-labels bundle. Browser SDK instances read `/api/internal/public-labels`; server SDK instances read the bundle source directly. The server selects hosted V3 or the configured static fork source. Portfolio reads request their required account fields explicitly and use the already loaded Lite labels snapshot for presentation, so they do not populate labels a second time.

| Public data | V3 path |
|---|---|
| Vault inventory and labels | `GET /labels/vaults?view=resolved&version=...&chainId=...` |
| Products | `GET /labels/products?view=resolved&version=...&chainId=...` |
| Entities | `GET /labels/entities?version=...` |
| Entity governance addresses | `GET /labels/entities/{entityId}/addresses` |
| Geo policy records | `GET /geo-policies` |

The adapter also reads `/evk/vaults` and `/earn/vaults` with explicit `visibility=visible,warning,hidden,pending_review`. Trusted label membership requires a visible or warning verdict and a managing entity. Hidden and pending metadata remain available without granting trusted membership. Per-side V3 explorability flags control hosted listing. The V3 verdict determines the verification badge on assessed chains.

Entity profiles supply hosted logo URLs. A product's `entityId` is its managing entity; `coBrandEntityIds` supplies additional display branding only. Co-brands do not participate in manager ownership, governor verification, or manager-profile market assignment. Neutral escrow inventory rows are not assigned to a product/entity and are not added to the labels-derived verified set.

Lite evaluates live V3 geo policies using `countriesResolved` and cumulative global/chain/product/vault/asset rules. Geo rules retain their own fetch time and disk checkpoint. A failed labels refresh can reuse label content with newer geo rules; a cached bundle never serves geo rules past their one-day limit. Mount `GEO_POLICY_CACHE_DIR` on persistent storage for redeploy durability. Hosted snapshots have no GitHub-label dependency. `LABELS_SOURCE=static` supplies the same snapshot from operator-owned files; see [Static labels](./static-labels.md). Production bake/canary remain rollout work. See [Geo-Blocking](./geo-blocking.md).

Oracle adapter identity and health assessments come from Data V3 through the SDK and Lite's same-origin V3 proxy. Detail views load an assessment per adapter; discovery loads the paginated chain catalogue. The UI uses V3's explicit `recognized` identity verdict and server-computed `checksStatus`, preserving `unknown` and `not_applicable` finding outcomes.

**Caching and fallback**: The server bundle has a 5-minute chain/version cache, concurrent cold loads share one in-flight fetch, and failures can return a bounded stale bundle while its geo rules remain usable. Hosted bundles carry the time of the V3 read, including when served from stale cache. The browser deduplicates chain-scoped loads and rejects superseded responses. Visible tabs check freshness every minute and on focus/visibility changes, requesting a fresh server bundle after five minutes. Same-chain refreshes retain display data and every action stays available while the bundle is younger than a day; V3 verification becomes unavailable one day after the last successful source read, even if the server returns that bundle again, and then every vault reads as unverified behind the app's backend-unavailable notice. The server keeps the last good bundle, verified set and metadata map for that day and refreshes them every five minutes. Public metadata can retain display text past source expiry, but it drops verified manager attribution at that deadline. The public verified-set cache uses the same source timestamp and caps its response-cache lifetime at that deadline. Requests time out after 35 seconds. Current hosted membership overrides cached positive registry flags, so refreshed revocations also update verification guards and verified EVault lists. Escrow perspective trust remains independent. An initial failure leaves labels unavailable with a retry action. Retry requests a fresh bundle and reloads vault discovery after labels recover.

**Inventory gaps**: The SDK reads direct V3 visibility for labelled vaults absent from the EVK/Earn inventories, with at most eight requests in flight. This covers Securitize labels without inventing a verdict. Effective lend/borrow listing decisions are preserved, so a visible collateral wrapper may remain hidden from lend discovery. Direct-verdict failures fail the aggregate refresh and use the same bounded stale-snapshot behavior described above.

**Address normalization**: All addresses from labels are checksummed via `getAddress()` before storage, ensuring consistent lookups regardless of input casing.

---

## Published Content Contract

Products provide `entityId`, optional `coBrandEntityIds`, display name, description, URL, portfolio notice, and direct product deprecation metadata. Vault inventory rows provide vault type, product/entity assignment, display metadata, tags, campaigns, and resolved vault deprecation metadata. V3 resolves the display cascade; Lite preserves empty resolved overrides instead of re-inheriting product notices.

Entity rows provide profile text, hosted logos, website/social links, and optional organization details. Lite also fetches each relevant entity's global governance addresses for metadata-only and static verification.

Verified EVK, Earn, Securitize and borrow-pair overviews show the managing entity's published profile in "Curator details": description, legal name, risk methodology, security information, terms, licenses, disclaimers and links when supplied. Explore market cards expose the curator description on hover and summarize V3 warning verdicts with their reasons. Missing profile fields are omitted.

Vault campaigns have a `name`, hosted `logo`, and `type` of `deposit` or `borrow`. Deposit campaigns render beside supply APY and borrow campaigns render beside borrow APY. Campaign badges are informational and do not change reward APR calculations. Campaign and entity logos use the allowlist in [Label logos](#label-logos), not the chain/oracle `v3ImagesUrl` host.

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

The URL is `{base}/oracle-providers/{key}`, where `base` is the public images base the server reads from its own V3 (`GET /v3/images`) and passes to the browser as `window.__APP_CONFIG__.v3ImagesUrl`. `V3_API_URL` and the API key stay server-side. When the base is unknown (V3 unreachable at boot, or an invalid answer), oracle-provider logos are not shown. `img-src` already allows `https:` (see [Token List](./token-list.md#csp)).

Lookup rules:

1. If `meta.provider` is present, map **only** that string. Do not fall through to the adapter name. A Midas vault priced by `ChainlinkOracle` must show the Midas logo, not Chainlink.
2. If provider is missing, map `meta.name` / the adapter type name (`ChainlinkOracle`, `PythOracle`, `UniswapV3Oracle`, …).
3. Unknown identifiers return `undefined` — the UI renders without a logo rather than guessing.

`utils/oracle-adapter-views.ts` assigns `view.logo` from those two fields when it builds the shared adapter view used by the borrow-page Oracles block and the Explore matrix.

---

## Label logos

Entity, product, and campaign logos are a different system from chain and oracle-provider logos. Chain / oracle artwork uses `window.__APP_CONFIG__.v3ImagesUrl` from V3 `GET /v3/images`. Curator artwork uses `resolveLabelLogo` (`utils/label-logo.ts`) and is never rewritten onto that public images base.

A hosted URL is kept only when it matches one of:

| Source | Accepted shape |
|--------|----------------|
| Euler V3 | `https://v3.euler.finance/v3/images/labels/{slug}` — slug `[A-Za-z0-9_-]+`, HTTPS, no credentials, no query, no hash, no extra path segments |
| Custom V3 | Origin of a non-default `V3_API_URL` (any path on that origin) |
| Extra CDN | Origins listed in `LABELS_IMAGE_ORIGINS` (comma-separated HTTP(S) origins, no path) |
| Static files | Filename `{name}.{svg\|png\|jpg\|jpeg\|webp\|gif}` resolved to `{STATIC_LABELS_BASE_URL}/logo/{filename}`, or an absolute URL on that same origin |

`https://token-images.euler.finance/...` is rejected by default. Credentials and unapproved origins (including lookalike hosts) are rejected for every source. The built-in Euler V3 rule also rejects HTTP, query strings, fragments, and paths outside `/v3/images/labels/{slug}`. Custom V3/CDN origins and absolute URLs on the static source's origin may include query strings or fragments. A rejected URL becomes `''` and the avatar shows initials.

The server publishes `logoOrigins` as the intersection of those configured origins with origins already present in **approved** logos in the bundle. Unused private V3 origins never reach the browser. `getEulerLabelEntityLogo` / `getEulerLabelPointLogo` re-run the same allowlist with that published list. Static bundles do not publish `logoOrigins`; `LABELS_IMAGE_ORIGINS` does not extend static image rules. Euler's V3 label image URLs still pass in static mode.

`/api/public/metadata` uses the same resolver for `entities[].logo`. Fork setup for extra CDNs is in [Fork setup → Images](./fork-setup.md#images).

---

## Vault Verification

### Building the Verified Set

For V3-assessed chains, `useEulerLabels` builds verified membership from visible or warning vaults with a managing entity. The client and `/api/public/is-known` use that membership as the verification verdict. Hidden and pending-review vaults can retain display metadata without becoming verified. Independent on-chain escrow-perspective membership also counts as verified.

Vault configuration checks and listing are separate V3 results. A vault can have passed checks and still be unlisted because it has no published vault label. The Vault checks UI says "Checks passed" for that assessment.

### Vault checks UI

The overview **Vault checks** accordion is hosted-V3 only (`source === 'v3'` and `isVaultAssessmentAvailableForChain`). Chains in `ONCHAIN_SDK_CHAINS` hide it. It is not a risk rating:

> Vault checks test this vault's configuration against fixed rules. They are not a risk rating or a recommendation by Euler.

Lend and Earn overviews render one card for the page vault. A borrow pair renders the liability vault and the EVK collateral; a Securitize collateral wrapper is omitted so only the borrow vault is checked. Each card shows a Status line (`getVaultChecksStatusLine`) and a Checks cell (`getVaultChecksCell`) that opens the findings pop-up.

The pop-up (`VaultAssessmentChecksModal` + `groupVaultCheckRows`) is one row per subject vault, not one row per rule:

- Strategy findings stay on that strategy's row; collateral findings stay on that collateral.
- A subject with a single check stays on one line, named after the vault.
- On Earn, the collateral group title is **Collateral in strategies** once; individual rows do not repeat that the Earn vault's checked collateral is its strategies'.
- `not_applicable` findings without `cause.summary` are omitted (data-only evidence such as `evidence.multisig` or `collateral.<address>.ramp`). A not-applicable finding that carries a cause, such as `governance.curator-registered` when the owner holds the curator role, still shows with an N/A tag.
- Failures that do not change listing show **Doesn't affect listing**.

Default liquidation-bot coverage is a separate badge; see [Server-Side Caching → Liquidation bot coverage](./server-side-caching.md#liquidation-bot-coverage).

### Unknown and flagged vaults

The UI sorts every vault that is not verified into one of two groups.

- **Flagged**: the V3 verdict is `hidden`. V3 hides a vault when a required check failed, when a check layer was suspended or revoked, or when the vault was marked as not to be listed. The vault keeps its real name and shows an amber "Flagged" chip; on a borrow pair the chip reads "Collateral flagged" or "Borrow flagged". The chip's tooltip is titled "Vault flagged" and shows V3's reason, or "Euler's checks flagged this vault." when there is none. The line under the name and the cause line under the checks read "Euler's checks flagged this vault: <reason>." The Curator value in the overview reads "Flagged".
- **Unknown**: every other vault that is not verified. This covers a vault with no V3 verdict, a `pending_review` verdict, and a vault that fails the verification rules (for example, no managing entity). The name and the Curator show the red "Unknown" chip. No line is shown under the name. The cause line under the checks reads "This vault has not been checked yet." (no verdict, or pending review), "This vault is not in the published vault labels." (unclaimed), or "This vault is in the published vault labels but could not be verified." (no managing entity).

`visible` and `warning` vaults with a managing entity are verified and get neither treatment. The "Deprecated", "Warning" and "Restricted" chips are unchanged. The "Warning" chip (and "Collateral warning" / "Borrow warning" on a pair) is still left out when its only failed checks were accepted exceptions. No vault state is described as "not listed". Flagged status needs ready V3 labels. Static and metadata-only sources never flag a vault.

The Lend, Borrow and Earn vault pages open a pop-up once per page, after the vault and the labels have loaded. No wallet is needed. On Borrow, the pop-up opens when either side of the pair is unknown or flagged. If any vault is unknown, the pop-up is the strict one: "Important!", a phishing warning, Yes / Cancel, and Cancel goes to `/`. If every vault that is not verified is flagged, the pop-up is titled "Vault flagged", gives V3's reason, and offers Continue / Go back. Go back returns to the previous page, or to `/` when there is none. Neither pop-up closes from the backdrop. `composables/useVaultOpeningNotice.ts` holds this logic.

Metadata-only and static sources have no V3 visibility verdict. Their verification path matches the on-chain governor, router governor, or Earn owner to the declared managing entity. See `utils/vault/governor-verification.ts` and the "Programmatic verification lookup" section below.

### Operation warnings and consent

Operation guards use the selected chain's verification source. Wallet connection and chain switching remain available before other form gates. New exposure waits for verification data or presents a retry action when that data is unavailable. A V3 `pending_review` verdict keeps the vault out of discovery and requires explicit unverified-vault acknowledgment before deposits and borrows. Existing-position exits remain available during a labels outage.

Vault pages show status in the page. Forms request explicit, account- and operation-scoped acknowledgment for unverified vault risk and a separate acknowledgment for deposits into deprecated vaults. The final execution policy checks the same requirements.

The acknowledgment covers every vault the operation targets, not only the vault of the page. Each form passes the vaults of its operation to `useOperationGuard`, for example the target collateral of a swap and the long vault of a multiply. Repay and position withdraw build that list with `collectPlannerVaultAddresses`, the rule the final policy uses. The final policy checks the acknowledgment against the vaults named in the planner arguments, so a vault a form leaves out blocks the transaction. If every unverified vault in the operation is flagged, the form's button reads "Review flagged vault". The confirmation then reads "This transaction uses a flagged vault: <reason>." with Confirm / Cancel. If any vault is unknown, the strict "Unverified vault" confirmation applies. The batch review reads its vaults from each entry's calldata (EVC batch targets, direct-call targets and approval spenders). It uses the same two texts.

Known gaps:

- The disable-collateral action on the position page has no form guard. For a collateral that is not verified, the final execution policy refuses that transaction, and no confirmation is shown first.
- The position borrow page lists the collateral beside the borrow vault, and the position swap page lists both sides of the position. Their planner arguments can name fewer vaults. When both a listed-only vault and a planned vault are unverified, the recorded acknowledgment does not match, and the final policy refuses the transaction.
- The batch review does not decode vaults that appear only as arguments of EVC calls, such as `enableCollateral`, and skips vaults that are not in the registry. The form guard and the final policy still cover those vaults.

### Governance hydration guard (SDK 2.0)

SDK 2.0 `EVault` instances always **own** the `governorAdmin` property (the constructor assigns it even when governance was never fetched). An `in`-operator or "property exists" check therefore passes on every real instance and can misread a lazily-hydrated vault as "governance resolved to nothing", producing false **Unknown curator** badges in discovery / market graph UI.

Use the value-based guard shared across badge sites:

```ts
hasResolvedGovernorAdmin(vault) // isEVault(vault) && vault.governorAdmin !== undefined
```

Only a **defined** `governorAdmin` means governance actually resolved. Until then, UI must wait (or show a loading/neutral state) rather than treating the vault as unverified.

### Ungoverned vaults

The UI shows "Ungoverned" from the on-chain zero governor (`governorAdmin` for EVK, `governor` for Securitize), independently of the verification verdict. Metadata-only and static sources still apply their entity-address check for verification.

### Governance facts

The EVK curator and address rows use `evidence.multisig` for Safe owner thresholds and `evidence.governance` for the router governor. Missing evidence falls back to the Safe and router RPC probes. These facts are informational and do not change verification or action gates.

The Earn Governance block shows on-chain owner, curator, guardian, timelock, pending timelock and guardian changes, pending strategy caps, and supply and withdraw queues from the SDK. It reads pending ownership from the Earn contract. V3 assessment evidence supplies allocator addresses and Safe thresholds; when that evidence is unavailable, allocator rows are omitted and visible governance addresses use the Safe RPC probe. The V3 timelock finding adds its reviewed judgment beside the on-chain duration.

### How `vault.verified` Is Set

| Vault Source | Verification Method |
|-------------|---------------------|
| **EVaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Earn vaults** | Verified if present in the normalized Public Labels `earnVaults` set |
| **Escrow vaults** | Loaded from `escrowedCollateralPerspective` on-chain (always verified) |
| **Securitize vaults** | Address appears in `verifiedVaultAddresses` from labels |
| **Unknown vaults** | Resolved via subgraph; verified only if in labels |

Registry presence is not Earn verification. `updateEarnVaults` / `refreshVaults` builds `verified` as `curatedAddresses.has(vault.address)` from `useEulerLabels().earnVaults`. On-demand unlisted Earn vaults stay unverified after a refresh that still fetches them. When an address is absent from the selected labels snapshot, the next Earn update clears its prior verification rather than copying `verified: true`. Server snapshot hydration can mark snapshot Earn rows verified because that snapshot only includes labeled earn addresses.

### On-Chain Perspectives

One on-chain perspective contract provides additional verification:

- **`escrowedCollateralPerspective`**: Lists all verified escrow collateral vaults. Vaults from this perspective are marked `verified: true`. Membership is used for discovery and verification; loaded classification comes from the SDK.

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

Loaded EVaults use the SDK's `isEscrow` flag: `true` means `escrow`, `false` means `standard`, and `null`/missing remains unknown, clearing any previous category. Lite does not recover classification from cached categories, snapshot buckets, or perspective membership. This applies to registry inserts, refreshes, server-snapshot hydration, and the server labels view. Classification does not grant verification: labels and on-chain perspective membership retain their existing trust rules. Snapshot buckets retain discovery provenance; the flag determines the loaded category. Before details load, perspective membership can identify discovery entries.

The selected SDK adapter supplies the flag: V3 first with on-chain fallback for normal browsing, and on-chain reads for `ONCHAIN_SDK_CHAINS`. A successful V3 entity with an unknown flag does not trigger automatic SDK fallback. Full escrow address discovery remains an on-chain perspective read on every chain.

For per-address lookups during direct navigation to a not-yet-cached vault, `fetchVaultCategory(address)` checks the SDK escrow verified array first, then asks `vaultMetaService.fetchVaultType` for the vault type.

**Important: labels remain authoritative for which vaults are _shown_.** SDK categorization says "what category each vault is"; normalized Public Labels products and earn-vault entries say "which vaults to include in lists". The two are composed in `useVaults.loadVaults`: labels select the set, categorization picks the right lens per address.

## Cyclical IRM overview

The cyclical Interest Rate Model block is **label-gated**, not IRM-type-gated.

`isVaultCyclicalNote(address)` in `utils/eulerLabelsUtils.ts` is true when the product `tags` or that vault's `vaultOverrides.tags` include `cyclical note`. That helper is what `VaultOverview.vue` uses to swap `VaultOverviewBlockCyclicalIRM` in for the generic IRM block. The same tag participates in these UI gates:

| Surface | Gate |
|---|---|
| Overview IRM block | `isVaultCyclicalNote(vault.address)` |
| `cyclicalNote` type badge | verified **and** the tag |
| Lend list "cyclical note" badge | the tag and verified vault governance |
| Borrow list "cyclical note" badge | the borrow vault's tag and verified governance for both vaults in the pair |
| Discovery graph "cyclical note" badge | the tag, subject to the graph's badge priority |
| Target-utilisation info warning (`useVaultWarnings`) | the tag, at least 95% utilisation, and a context other than `repay`; repay keeps its standard high/critical warning |

`isCyclicalNoteVault` in `utils/vault/classification.ts` is a different helper: it only inspects `vault.interestRateModel.type` (`FIXED_CYCLICAL_BINARY` = 4 or `FIXED_CYCLICAL_BINARY_MONTHLY` = 5). A vault can have a cyclical IRM on-chain and still render the generic IRM block if the label tag is absent. Do not treat the type number as permission to show cyclical-note UI.

Inside `VaultOverviewBlockCyclicalIRM.vue` the block still hides itself unless the vault has collateral exposure (`hasCollateralExposure`) and a non-zero IRM address. Both IRM variants are then normalised into one `{ primaryRate, secondaryRate, startSec, primaryDurationSec, secondaryDurationSec }` cycle:

| `interestRateModel.type` | Cycle bounds | Date display |
|---|---|---|
| `FIXED_CYCLICAL_BINARY` | `startTimestamp` plus `primaryDuration` / `secondaryDuration` | Local timezone |
| `FIXED_CYCLICAL_BINARY_MONTHLY` | UTC calendar month; `cycleStartDay` must be `1n…31n` or the cycle is `null` | UTC |

The monthly variant clamps a start day past a short month to that month's last day (`Math.min(startDay, daysInMonth)`) so `Date.UTC` cannot roll 31 February into March. That matches the contract.

The live "Now" marker and elapsed-cycle math use:

```ts
const now = useNow({ scheduler: cb => useIntervalFn(cb, 1_000) })
```

The custom scheduler updates the clock once per second; VueUse 15's bare `useNow()` is valid and defaults to animation-frame updates. Borrow APYs on the block convert the IRM's 27-decimal per-second rate (`SPY`) with `(1 + spy)^(secondsInYear) - 1`.

## Discovery Page Filtering

`LABELS_VAULT_TAG` optionally selects vaults whose tags contain that exact, case-sensitive string. Leading/trailing env whitespace is trimmed; an unset or blank value applies no tag filter. Any tag is supported, including `base` and `governance limited`. A configured tag with no matches produces empty discovery. Set the env before server startup and restart after changing it.

Both Main and Base can use `LABELS_V3_SET=public`; Base additionally sets `LABELS_VAULT_TAG=base`. Populate the desired tags in V3 before enabling the filter. Hosted mode matches each vault row independently, including Earn, Securitize and escrow rows; metadata-only chains use the same tags without requiring V3 indexing. Static mode matches product tags, vault-override tags and Earn-entry tags using its authored inheritance rules.

The filter applies to Explore group members and metrics, Lend/Borrow/Earn lists, both sides of borrow pairs, and new-target suggestions in swap/migration forms. The `showAll` query does not bypass it. Existing visibility, verification, listing and geo rules still apply. Label refreshes update the selection while preserving loaded vaults used by open forms.

On Lend, Borrow and Earn, `?showAll` includes verified vaults that the labels mark as not explorable for that page. It does not include hidden or pending-review vaults, override the deployment tag, or change geo restrictions. On Portfolio, the same query opens the existing "Show all positions" view for the user's positions; it does not change vault verification. On Explore, `?showAll` also lists products without an explorable market side and keeps every member in their graphs. The "Recently added" badge and sort order follow the published `recently added` tag, so publication controls that designation rather than a client-side age cutoff.

Full labels and vault snapshots remain available for positions, direct URLs, collateral relationships and Earn strategy details. Tag selection does not change verification, geo policies, `/api/public/is-known` or `/api/public/metadata`; it is a discovery setting, not an access restriction.

Labels control which vaults appear on each discovery page:

| Flag | Lend | Borrow | Explore market graph |
|------|------|--------|---------|
| Vault `notExplorableLend: true` | Hidden | Visible | Member; dropped while it has no live LTV edge |
| Vault `notExplorableBorrow: true` | Visible‡ | Hidden, as the loan and as the collateral | Member* |
| Hidden on both sides, or product `notExplorable: true` | Hidden | Hidden | Only as accepted collateral, "Unlisted" badge† |
| Deprecated (V3) | Hidden | Hidden | Only as accepted collateral, "Deprecated" badge† |
| `recently added` tag | Sorted to top | Sorted to top | Sorted to top |

Each flag is a table: the lend flag controls the Lend and Earn lists, the borrow flag every Borrow pair the vault takes part in. On V3, deprecation hides both sides unless a side is re-listed where V3 allows it; a re-listed side behaves as listed. Static and metadata-only labels do not hide deprecated vaults: they stay product members with a "Deprecated" badge. An explicit per-vault flag overrides the product setting for that side; a missing flag inherits it.

‡A lending vault is listed while it is open for deposits and has a pair with borrow LTV > 0 against a collateral whose borrow side is listed (`utils/vault/borrow-table.ts`). The vault's own borrow flag and borrow pauses do not affect this. On V3, hiding or deprecating its only such collateral removes the lending vault from Lend.

*A member with no live LTV edge stays in the graph and matrices only while its lend side is listed. A live edge has borrow LTV > 0 or a current liquidation LTV above zero (`isLiveCollateralEdge`).

†A vault hidden on both sides appears in a market only while a member accepts it as collateral with a live LTV. When it is only the loan side of live LTVs, it is not drawn.

Explore lists a product only while it has an explorable market side: at least one member vault that is open on the lend side, or borrowable (including residual debt) and open on the borrow side. A collateral-only product — every member flagged `notExplorableLend` and not borrowable, e.g. issuer-governed Securitize collateral wrappers — gets no Explore card. Its vaults still render as external collateral in other markets' graphs, and its direct market URL still resolves on demand (members are satisfied from the vault registry first, so non-EVault members load correctly). Such on-demand markets, and every market under `?showAll`, keep all of their members; a listed market opened by direct URL follows the rules above.

Vaults hidden from discovery are still accessible via direct URL and remain visible in the user's portfolio.

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
| `utils/label-logo.ts` | Allowlist for entity / product / campaign logo URLs |
| `utils/vault-assessment/presentation.ts` | Vault-checks copy, grouping, and listing-impact tags |
| `utils/eulerLabelsUtils.ts` | Lookup and helper functions backed by the normalized label snapshot |
| `server/utils/public-labels-source.ts` | Shared V3 aggregate cache used by browser, public APIs, and vault snapshots |
| `server/utils/static-labels-source.ts` | Atomic authoring-file source and durable checkpoint for forks |
| `composables/useEulerLabels.ts` | Chain-scoped aggregate loading and normalized label publication |
| `composables/useVaultRegistry.ts` | Vault registry with type detection and unknown resolution |
| `composables/useGeoBlock.ts` | V3 country evaluation and independent sanctions gate |

## Programmatic verification lookup

External consumers that only need a yes/no answer for a vault address can call the public [`GET /api/public/is-known`](./public-api.md#get-apipublicis-known) endpoint instead of loading the full label set. It uses V3 verified membership on assessed chains, the governor / router-governor / owner check on metadata-only and static sources, and independent on-chain `escrowedCollateralPerspective` membership. It answers batches of up to 100 addresses per request. Deprecation does not change the verification verdict.

Consumers that need display metadata (resolved name, description, governing entity, asset) on top of the verification verdict can call [`GET /api/public/metadata`](./public-api.md#get-apipublicmetadata), which applies the same labels / override / verification rules the client UI uses and returns a uniform shape across EVK, Securitize, and Earn vaults.


On assessed chains, V3 supplies the managing entity and effective visibility verdict, including for standalone Earn vaults. A visible or warning row without a manager does not grant verified membership. Both client and public APIs apply this rule. Static Earn labels preserve their authored membership semantics.

## Archived chains: V3 metadata with on-chain verification

Enabled chains marked `deprecated` in `EulerChains.json` select the SDK's `PublicLabelsV3MetadataAdapter`. `DEPRECATED_CHAINS` is an optional override with the same effect. Each selected chain must also be in `ONCHAIN_SDK_CHAINS`; a missing entry is a configuration error. Chains without a configured RPC are ignored, and other enabled chains keep V3 assessments even if they use on-chain SDK reads. The shared server labels loader reads the admitted Euler interfaces manifest before selecting or serving a cached adapter result. If no manifest is available, hosted labels remain unavailable until it loads. No separate labels chain variable is required.

The SDK shares metadata fetching and display mapping between its adapters. Metadata-only bundles carry `source: 'v3-metadata'` and contain no visibility verdicts. They use the same label set/publication selection, live entity addresses and live geo policies as the assessed path. Candidate addresses are separate from verified membership.

Lite selects the adapter once in its shared server labels loader. The browser, vault snapshots and public APIs use that selection. The metadata-only path applies the existing governor/router/owner checks against the vault's explicit managing entity; an absent manager cannot inherit static Earn trust. Registry verification uses current candidates and entity addresses rather than a cached positive flag. Independent escrow-perspective verification remains applicable.

Metadata-only discovery follows published product `notExplorable` and per-vault `notExplorableLend` / `notExplorableBorrow` flags and normal market filters. An explicit vault-side `false` overrides a hidden product for that side; a missing flag inherits the product setting. Explore product cards are label/market driven; governance checks separately control verified vault lists and verification badges. Deprecation alone does not hide a vault; Earn uses its lend-side flag before the product setting. Published deprecation, notices and tags remain available for unnamed EVKs without creating a blank display product. V3 assessment-based platform listing controls are not synthesized for these chains. Errors on normally assessed chains never switch them to metadata-only handling. Static fork mode remains independent.

Live labels refreshes reload vault data when membership or discovery eligibility changes; text-only updates use the reactive labels store. This brings newly eligible vaults into the registry without requiring a page reload. Same-chain label refreshes retain already loaded vaults, including unlisted vaults used by open forms; current hosted membership still controls verification. Ordinary loads and chain changes clear the registry. Batch-review account reads request quantitative data explicitly and do not invoke the SDK's default file-based labels service through `populateAll`.
