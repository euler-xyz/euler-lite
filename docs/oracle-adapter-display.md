# Oracle Adapter Display

Borrow pair overviews and the Explore market-matrix “oracle” metric share one collection + enrichment path so they always agree on which adapters price a (liability, collateral) pair.

This is display and trust UX, not the USD pricing pipeline. Position values still come from [Pricing System](./pricing-system.md). Pyth pull mechanics for reads and transactions are in [Pyth Oracle Handling](./pyth-oracle-handling.md). Curated adapter metadata lives in [oracle-checks](https://github.com/euler-xyz/oracle-checks); loading details are in [Vault Labels & Verification](./vault-labels-and-verification.md#oracle-adapter-files-oracle-checks-repo).

## Files at a Glance

| File | Role |
|------|------|
| `utils/oracle-route-steps.ts` | Debt / collateral route accessors; hide the collateral vault’s own ERC-4626 step |
| `utils/oracle-adapter-views.ts` | Deduped step collection + `OracleAdapterView` enrichment |
| `entities/oracle.ts` | Identity (`resolveOracleAdapterIdentity`), checks status, router recognition |
| `utils/oracle-label.ts` | Invert displayed `getQuote` when the router calls the feed backwards |
| `entities/oracle-providers.ts` | Provider → logo map (no on-chain-name fallback when a provider is set) |
| `composables/useOracleAdapterPrices.ts` | EVC `batchSimulation` quotes (Pyth updates + `getQuote` / `convertToAssets`) |
| `composables/useEulerOracleAdapters.ts` | Per-chain whole-map load via SDK `fetchOracleAdapterMap` |
| `composables/useEulerOracleRouters.ts` | Recognized EulerRouter allowlist |
| `components/entities/vault/overview/VaultOverviewBlockOracleAdapters.vue` | Oracles accordion (pair overview, discovery accordion) |
| `components/entities/vault/discovery/DiscoveryMarketMatrix.vue` | Per-cell adapter views for the oracle metric |

## Which Steps Are Shown

`collectOracleRouteSteps(liabilityVaults, collateralVaults)` unions:

1. Each liability’s `debtPricingOracleRoute.steps` (asset → unit of account).
2. Each matching `liability.collaterals[].oracleRoute.steps`.

Steps are keyed by `kind:oracle:base:quote` (`getOracleRouteStepKey`) and deduped.

Collateral routes drop a `kind: 'vault'` step whose `base` is the collateral vault address (`shouldHideDisplayedVaultStep`). That step is the vault’s own share→asset unwrap and would duplicate the collateral vault itself.

The Explore matrix leaves the self-diagonal blank on purpose: a liability’s asset→UoA adapter already appears in every other cell of its column.

## Label vs Route

Each card has two pair strings. They are not interchangeable.

| UI field | Source | Example |
|----------|--------|---------|
| Title | Curated `meta.label`, split at the first `(` into primary + parenthetical suffix. If there is no label, `{base symbol}/{quote symbol}` from the **route step**. | `USDC / USD` + `(0.25%, 82800s)` |
| Route | Always `{base}/{quote}` symbols from the route step the router actually uses | `psUSDC/USD` |

A proxy or wrapping feed often has a label written for the underlying (USDC/USD) while the configured route prices a different token (psUSDC/USD). Do not render the feed label in the Route column.

## Identity and Custom Adapters

`resolveOracleAdapterIdentity(step, meta, isAdapter)`:

- **Adapter steps** (`kind === 'adapter'`) take `name` / `provider` only from the curated oracle-checks entry. If that entry is missing, Lite must **not** fall back to the on-chain `name()` — that string is attacker-controllable and would let an unknown adapter masquerade as Chainlink/Pyth/etc. The view is flagged `isCustomAdapter` and the UI shows provider **Unknown** and checks **Custom — set by risk manager**.
- **Structural vault steps** (`kind === 'vault'`) keep the decoded route name (e.g. `ERC4626Vault`) and default methodology **Exchange Rate**. They are not adapters.

Provider logos come from `getOracleProviderLogo(provider, name)`. When `provider` is set, only that key is used — a Midas adapter implemented with `ChainlinkOracle` must not inherit the Chainlink logo.

## Checks and Router Recognition

Curated `checks[]` (`id`, `message`, `pass`, `severity`) drive a traffic-light:

| Status | Rule |
|--------|------|
| `null` | No checks (including custom adapters) |
| `positive` | Every check passed |
| `negative` | Any failed check has severity `HIGH` |
| `warning` | Failed checks, none high |

Failed checks are listed under the card. High severity uses the error color; others use warning.

**Unrecognized router** (`data-field="oracle-router-recognition"`): `getRouterRecognition` compares each liability `vault.oracle.oracle` against `/api/internal/oracle-routers` (`{oracle-checks}/{chainId}/routers/all.json`, addresses deployed by the recognized EulerRouterFactory). Returns `null` — show nothing — when the allowlist is empty or still loading for the active chain, so a missing dataset never produces a false “unrecognized” warning.

## Display Prices

`useOracleAdapterPrices` is a **read-path** quote for the Oracles block, not the USD helpers in `utils/sdk-prices.ts`.

1. Seed decimals from the liability / collateral vault assets, shares, unit of account, and well-known placeholders (USD/EUR/BTC/ETH → 18).
2. `decimals()` via EVC batch for anything still unknown. A failed batch skips those adapters rather than mis-pricing them. A failed individual `decimals()` call defaults to 18 so non-ERC-20 placeholders still quote.
3. Collect Pyth feeds from the route adapters, fetch Hermes updates through the same-origin proxy, and prefix `updatePriceFeeds` items.
4. Quote each step: `convertToAssets(10 ** baseDecimals)` for vault steps, `getQuote(amount, base, quote)` for adapter steps.
5. One EVC `batchSimulation`; decode the quote suffix (skip Pyth update results).

`shouldInvertOraclePrice` compares curated `meta.base` / `meta.quote` to the route step’s caller pair. If the router calls the adapter with the wired pair flipped, the displayed rate is `1 / raw`. If the pairs do not line up in either direction, do not invert.

Failed quotes render as **Unknown** with a warning icon, not `0`.

## Metadata Load (Do Not Refetch Misses)

`useEulerOracleAdapters` loads the **whole** per-chain map once via `sdk.oracleAdapterService.fetchOracleAdapterMap(chainId)` → `GET /api/internal/oracle-adapters?chainId=`.

A lookup miss after that load means the adapter is not in oracle-checks. Reloading cannot surface it, and rewriting `oracleAdaptersRef` re-triggers every subscriber — that loop froze Explore for markets whose custom adapters are absent from the dataset. `loadOracleAdapter` therefore returns `undefined` on a miss without refetching.

The map is rebuilt only when `chainId` changes. `toReactive(computed(…))` for the exported map is constructed at **module init**, not inside `useEulerOracleAdapters()`, so a `computed` that merely *calls* the composable (via `useEulerLabels`) does not subscribe to adapter loads.

`GET /api/internal/oracle-adapter?chainId=&address=` still exists for a single `{address}.json`, but no Lite UI caller uses it. Prefer the bulk route.

List handlers (`oracle-adapters`, `oracle-routers`) use a 5-minute TTL. A 404 returns `[]` **without** caching the empty array, so a missing upstream is retried on the next request instead of pinning every client to empty for the TTL. Transient errors serve stale when present, otherwise `[]` (also uncached). Rate limit is 60 req / 60 s (tighter than the generic 1,000-unit proxy budget).

## Constraints

- Both surfaces must go through `collectOracleRouteSteps` + `buildOracleAdapterViews`. Duplicating step collection in a component will drift.
- Never display an adapter step’s on-chain `name()` as the provider.
- Keep the Route column on the route step pair, even when `meta.label` names a different feed.
- Do not treat an empty router allowlist as “unrecognized”.
- Do not refetch the adapter map because one address missed.
