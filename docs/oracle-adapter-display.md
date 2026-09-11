# Oracle Adapter Display

Shared display contract for the vault Oracles block and the Explore market-matrix oracle metric. Both surfaces must agree on which adapters price a (liability, collateral) pair, and they must never take identity from an adapter's self-reported on-chain `name()`.

V3 assessment payload shape lives in [Vault Labels & Verification](./vault-labels-and-verification.md#oracle-adapter-assessments-data-v3). Display quotes are independent of the USD helpers in [Pricing System](./pricing-system.md). Pyth updates that precede those quotes are covered in [Pyth Oracle Handling](./pyth-oracle-handling.md).

## Intent

Data V3 assesses adapters. Lite only:

1. Collects the live decoded EulerRouter route.
2. Joins it to V3 assessments.
3. Renders identity, health, and an EVC-simulated quote.

```text
decoded OracleRouteStep[]          V3 assessments (SDK → /api/internal/v3)
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
         collectOracleRouteSteps
         buildOracleAdapterViews
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
VaultOverviewBlockOracleAdapters   DiscoveryMarketMatrix (oracle metric)
         │
         ▼
useOracleAdapterPrices  (EVC batchSimulation getQuote / convertToAssets)
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

Health and label apply only when the assessed config pair matches the routed pair (either direction). A recognized adapter whose config pair is a different market still shows the routed Route column, with `assessmentPairMatchesRoute === false` and no health verdict.

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
| `recognized` | V3 identified the adapter | Health verdict + pass/fail/unknown counts (when the pair matches the route) |
| `unrecognized` | V3 assessed the address but refused identity | **Unrecognized**, plus `reason` (retitled rule key) and **identity findings only** |
| `unassessed` | No row | **Not assessed** for custom adapters; **N/A** for structural steps |

Identity findings (`ORACLE_IDENTITY_CHECK_KEYS`): `adapter-exists`, `adapter-class-known`, `source-provenance`, `custom-adapter-recognized`. Every other finding on an unrecognized adapter was read through getters recognition refused to trust and is withheld.

Rule keys become sentence-case titles in the client (`formatOracleCheckTitle`), so a new V3 rule renders without a Lite release.

When the V3 backend itself is down, both surfaces show **Oracle information not available** (`oracleAssessmentsStatus === 'unavailable'`). That is a section-level status, not an adapter verdict. The Oracles block also hides route cards until status is `available`, so a failed trust source cannot look like a list of Unknown adapters.

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

Failed quotes render **Unknown**, not `0`.

## Troubleshooting

- **Explore oracle metric stuck on "Oracle information not available":** V3 proxy/backoff or `useV3ChainGate` off for the chain. Status is chain-scoped; switching networks does not reuse another chain's `available`.
- **Vault page shows Unknown for a well-known adapter:** assessment `recognized` is false, missing, or the config pair does not match the route. Do not "fix" it by reading `name()`.
- **Health checks missing on a recognized adapter:** `assessmentPairMatchesRoute === false` — the V3 config pair is a different market than the decoded route.
- **Fallback-oracle adapter missing after catalogue refresh:** per-address load should have tagged it in `oracleAdapterPerAddressKeys`; a catalogue-only merge would drop it.
- **Unrecognized-router chip with an empty dataset:** `getRouterRecognition` should have returned `null`. Check that the recognized set actually loaded.

## Tests

- `tests/utils/oracle-adapter-views.test.ts` — collection, pair match, identity fallback
- `tests/composables/useEulerOracleAdapters.test.ts` — catalogue extras, freshness, unavailable vs loading
- `tests/composables/useEulerOracleRouters.test.ts` — chain filter, empty-set null policy
- `tests/entities/oracle.test.ts` — identity keys, reason titles, evidence lines
