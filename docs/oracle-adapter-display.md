# Oracle Adapter Display

Shared display contract for the vault Oracles block and the Explore market-matrix oracle metric. Both surfaces must agree on which adapters price a (liability, collateral) pair, and they must never take identity from an adapter's self-reported on-chain `name()`.

V3 assessment payload shape lives in [Vault Labels & Verification](./vault-labels-and-verification.md#oracle-adapter-assessments-data-v3). Display quotes are independent of the USD helpers in [Pricing System](./pricing-system.md). Pyth updates that precede those quotes are covered in [Pyth Oracle Handling](./pyth-oracle-handling.md).

## Intent

Data V3 assesses adapters. Lite only:

1. Collects the live decoded EulerRouter route.
2. Joins it to V3 assessments.
3. Renders assessed identity and health when available, with an EVC-simulated quote.
4. Shows route, address, and returned price details when assessments are unavailable.

```text
decoded OracleRouteStep[]
             |
   collectOracleRouteSteps
             |
      +------+------------------------+
      |                               |
      v                               v
useOracleAdapterPrices      V3 assessments available?
(EVC batchSimulation)           |                 |
      |                       yes               no
      v                        v                 v
Returned price         buildOracleAdapterViews   Route + address only
                               |                 |
                               +--------+--------+
                                        v
                         VaultOverviewBlockOracleAdapters

DiscoveryMarketMatrix uses assessed adapter views;
its oracle grid is hidden when assessments are unavailable.
```

There is no dedicated `/api/internal/oracle-adapters` route. Catalogue and per-address loads go through `sdk.oracleAdapterService`, which hits the V3 proxy allowlist.

## Shared collection

`utils/oracle-adapter-views.ts` is the single source of truth.

`collectOracleRouteSteps(liabilityVaults, collateralVaults)` unions, then dedupes by `kind:oracle:base:quote`:

- each liability's asset → unit-of-account (debt) route
- each collateral → that liability's unit-of-account route

`buildOracleAdapterView(step, oracleAdapters)` joins one step to `OracleAdapterMeta`. Do not reimplement this per component.

## Label vs Route

| Column | Source |
| --- | --- |
| Title | Curated `meta.label`, split at the first `(` into `primary` + `suffix`. If there is no recognized label, the title falls back to the route-step `base/quote` symbols. |
| Route | Always the decoded route-step `base/quote`. Never the assessment config pair. |

For recognized assessments, label and health applicability use `assessmentApplies = pairMatches !== false`:

- A config pair matching the routed pair in either direction returns `true`; the label and health apply.
- Missing assessment base or quote metadata returns `null`; the recognized assessment label and health still apply.
- An explicit pair mismatch returns `false`; the label, health findings, and health verdict are suppressed. The Route column still shows the decoded routed pair.

Pair matching controls label and health applicability independently of adapter identity recognition. A recognized adapter retains its curated name and provider even when the assessed pair explicitly mismatches the route.

## Identity — never trust `name()`

`resolveOracleAdapterIdentity` in `entities/oracle.ts`:

- Adapter steps (`isOracleAdapterRouteStep`) take `name` / `provider` only from a **recognized** V3 assessment.
- Missing assessment or `recognized: false` → `isCustomAdapter: true`, rendered as **Unknown**. Do not fall back to the on-chain `name()` — that getter is attacker-controllable.
- Structural route steps (ERC-4626 `vault` exchange-rate legs) are not adapters. They keep the decoded step name.

`checksStatus` is V3's health verdict. Do not recompute it from individual findings.

## Assessment states

`getOracleAssessmentState(meta)`:

| State | Meaning | Checks cell |
| --- | --- | --- |
| `recognized` | V3 identified the adapter | Health verdict + pass/fail/unknown counts unless the assessed pair explicitly mismatches the route |
| `unrecognized` | V3 assessed the address but refused identity | **Unrecognized**, plus `reason` (retitled rule key) and **identity findings only** |
| `unassessed` | No row | **Not assessed** for custom adapters; **N/A** for structural steps |

Identity findings (`ORACLE_IDENTITY_CHECK_KEYS`): `adapter-exists`, `adapter-class-known`, `source-provenance`, `custom-adapter-recognized`. Every other finding on an unrecognized adapter was read through getters recognition refused to trust and is withheld.

Rule keys become sentence-case titles in the client (`formatOracleCheckTitle`), so a new V3 rule renders without a Lite release.

When V3 assessments are unavailable or disabled for the chain (`oracleAssessmentsStatus === 'unavailable'`):

- The vault Oracles block shows **Oracle verification unavailable** with the decoded route, adapter address (or vault address for an ERC-4626 leg), and a **Returned price** quoted through RPC.
- A returned price is expressed as `1 base = amount quote` in the decoded route direction. It does not use assessment labels or invert against retained assessment metadata.
- Names, provider artwork, methodology, recognition warnings, and checks are withheld, including any retained V3 metadata. An unavailable trust source does not classify adapters as unrecognized.
- Missing route steps show **Route information not available**. A failed or unscalable quote shows **Quote unavailable**, while the route and address remain visible.
- The Explore oracle matrix shows **Oracle information not available** without an empty grid.

These are availability states, not adapter verdicts. Initial assessment loading does not show the unavailable fallback.

## Catalogue vs per-address load

`composables/useEulerOracleAdapters.ts`:

| Caller | Load |
| --- | --- |
| Explore matrix (`DiscoveryMarketMatrix`) | `loadAllOracleAdapters(chainId)` — active-route catalogue (`fetchOracleAdapterAssessments({ active: true })`) |
| Vault Oracles block | `loadOracleAdapters(chainId, adapterAddresses)` — per-address for each decoded adapter |

The catalogue is **not** the full assessment set. It is adapters in a live vault route (`inActiveRoute`). Fallback-oracle-only adapters are resolved on demand by the per-address path.

Catalogue hits within `ORACLE_ADAPTER_CATALOGUE_FRESH_MS` (5 min) skip a per-address fetch. Catalogue **misses still go to the SDK** — they may be inactive or fallback-oracle adapters. Do not treat a miss as "do not refetch"; that freeze applied to an older whole-map labels load and would hide fallback-oracle adapters.

Catalogue refresh keeps entries previously loaded per-address (`oracleAdapterPerAddressKeys`) so a later active-route snapshot cannot blank an adapter still on screen.

`markAssessmentsLoading` does not clear an already-`available` chain. Established cards stay visible while V3 revalidates.

V3-disabled chains (`useV3ChainGate`) mark assessments `unavailable` without calling the SDK.

## Router recognition

`useEulerOracleRouters` loads `/v3/oracles/routers` through `sdk.oracleAdapterService.fetchOracleRouters`. V3 lists exactly the routers deployed by the recognized `EulerRouterFactory`.

`getRouterRecognition(addresses, recognizedSet)`:

- empty recognized set or no router addresses → `null` (show nothing)
- every address in the set → `'recognized'`
- otherwise → `'unrecognized'` (Oracles-block warning)

An empty allowlist must never produce a false "unrecognized" warning.

CREATE2 reuses router addresses across chains; Lite keeps only rows whose `chainId` matches the request.

## Display quotes

`useOracleAdapterPrices` is a read-path quote, not `utils/sdk-prices.ts`.

One EVC `batchSimulation`:

1. Pyth update items for adapters on the route (`buildPythBatchItemsFromFeeds`).
2. `getQuote` on adapter steps, or `convertToAssets` on ERC-4626 vault steps.

`shouldInvertOraclePrice` compares the assessment config pair with the routed pair. Invert only when they are exact swaps of each other; a no-match pair is not flipped.

Failed quotes render **Unknown** in assessed cards and **Quote unavailable** in the fallback. Successful zero quotes remain zero.

Token and share decimals come from the vault entities or successful RPC reads. Failed or malformed decimal reads leave the affected quote unavailable; only the explicitly known unit-of-account placeholders use fixed decimals.

Quote requests capture the chain, EVC address, route, and decimals. Switching chains or routes clears displayed quotes, and obsolete or disposed requests cannot publish their results.

## Troubleshooting

- **Explore oracle metric stuck on "Oracle information not available":** V3 proxy/backoff or `useV3ChainGate` off for the chain. Status is chain-scoped; switching networks does not reuse another chain's `available`.
- **Vault page shows Unknown for a well-known adapter:** the assessment is missing or `recognized` is false. Pair mismatch does not make a recognized adapter Unknown. Do not "fix" it by reading `name()`.
- **Assessment label and health suppressed on a recognized adapter:** `assessmentPairMatchesRoute === false` — the V3 config pair explicitly mismatches the decoded route. Missing base or quote metadata yields `null` and does not suppress these fields.
- **Fallback-oracle adapter missing after catalogue refresh:** per-address load should have tagged it in `oracleAdapterPerAddressKeys`; a catalogue-only merge would drop it.
- **Unrecognized-router chip with an empty dataset:** `getRouterRecognition` should have returned `null`. Check that the recognized set actually loaded.

## Tests

- `tests/utils/oracle-adapter-views.test.ts` — collection, pair match, identity fallback
- `tests/composables/useEulerOracleAdapters.test.ts` — catalogue extras, freshness, unavailable vs loading
- `tests/composables/useEulerOracleRouters.test.ts` — chain filter, empty-set null policy
- `tests/entities/oracle.test.ts` — identity keys, reason titles, evidence lines
