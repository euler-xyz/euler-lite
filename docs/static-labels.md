# Static label authoring

`LABELS_SOURCE=v3` is the default hosted mode. It reads published metadata, live visibility, governance addresses and geo policies from V3, without consulting any labels repository.

Forks select `LABELS_SOURCE=static` and set `STATIC_LABELS_BASE_URL` to their own HTTP(S) directory. The server and browser consume the same normalized snapshot as hosted mode. Authored membership determines discovery; hosted curation/visibility is never consulted. The SDK provides the shared file derivation function, while Lite owns atomic fetching, validation, caching and logo policy.

## Directory contract

For each enabled chain, serve these JSON documents:

| Path | Shape and fields |
|---|---|
| `{chainId}/products.json` | Object keyed by product slug. Each product includes `name`, `entity` (entity key or keys), `vaults`; optional `deprecatedVaults`, `deprecationReason`, `description`, `portfolioNotice`, `tags`, `notExplorable`, `block`, `restricted`, and address-keyed `vaultOverrides`. Overrides support text, tags, country rules and `notExplorableLend/Borrow`. |
| `{chainId}/entities.json` | Object keyed by entity key. Profiles include `name`, `logo` filename, `description`, `url`, `addresses` (address-to-label map), and `social` URLs. These addresses drive governor/owner checks. |
| `{chainId}/points.json` | Array of `{name, logo, collateralVaults}` campaigns. |
| `{chainId}/earn-vaults.json` | Array of vault addresses or `{address, deprecated, deprecationReason, description, portfolioNotice, notExplorable, block, restricted, tags}` objects. |
| `{chainId}/assets.json` | Array of address or symbol/name matchers: `address`, `symbols`, `names`, `symbolRegex`, `nameRegex`, plus `block` / `restricted`. |
| `all/assets.json` | Global asset rules, combined with each chain's rules. |
| `logo/{filename}` | Entity/product/points images on the same origin. |

Use explicit `{}` or `[]` documents for empty collections, including both asset files. Missing files and HTTP errors are failures, not empty policy. A source missing optional files from older layouts must add those explicit empty documents. File syntax retains the five-file authoring format; no generated normalized snapshot needs editing. [`tests/fixtures/static-labels.json`](../tests/fixtures/static-labels.json) is an executable example of the file contents.

Only HTTP(S) profile links and simple image filenames are accepted. Remote hosted label images must use `https://token-images.euler.finance`; static images may additionally use the configured source origin. Paths/credentials and lookalike hosts cannot bypass the image allowlist. The browser repeats the image check before rendering.

## Failure behavior

All six JSON documents load together. A failed, malformed or partial refresh retains the complete last-known-good snapshot, including its rules. No snapshot is published on a cold start without a valid complete set. Checkpoints are source-and-chain-specific, content-hashed and timestamped. Mount `GEO_POLICY_CACHE_DIR` on persistent storage for container replacements; the default `.data/geo-policies` only persists on the same filesystem. Stale fallback and failed checkpoint writes are logged for alerting.

Authored geo retains static country-group expansion and override semantics. This differs deliberately from hosted V3's cumulative rules. The contract test covers discovery, entities/authority addresses, points, logos, per-side flags, asset patterns, Earn restrictions and restart recovery.

## On-chain data

Static labels do not require running a V3 backend. A fork may use Euler's hosted quantitative endpoints for supported factory vaults, subject to API availability and access policy. Alternatively, configure `ONCHAIN_SDK_CHAINS` and the existing V3 feature gate for direct on-chain SDK reads. That mode has reduced history/activity/rewards coverage; static labels do not create an indexer or add support for arbitrary chains.

## Rollout boundary

Before switching production, compare authored and V3 membership, explorability, display content, geo decisions and full verification across enabled chains. Resolve unexplained differences; preserve public API behavior and measure revocation latency. On-chain governor verification remains active in hosted mode during this bake. SDK release/dependency changes, persistent volumes, alerting, compliance canary and production cutover are deployment work.
