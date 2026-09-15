# Static label authoring

`LABELS_SOURCE=v3` is the default hosted mode. It reads published metadata, live visibility, governance addresses and geo policies from V3, without consulting any labels repository.

Hosted deployments select metadata with `LABELS_V3_SET` (default `public`) and `LABELS_V3_VERSION` (default `latest`, or an immutable publication key such as `v20260911011146353` or `test-2026-06-30`). The SDK resolves `latest` within the selected set and applies that set/version to vault, product and entity metadata. Server caches separate upstream, set, chain and version. Unknown sets or unavailable publications fail rather than falling back to public. The internal endpoint's explicit `version` query still overrides the deployment default for diagnostics; the label set is server-configured. Draft selectors are not supported. Restart the service after changing these variables.

These settings select published metadata, not an isolated staging system: visibility, geo policies, governance addresses and live platform fields continue to use the configured V3 backend. Static mode ignores the V3 label selectors.

Forks select `LABELS_SOURCE=static` and set `STATIC_LABELS_BASE_URL` to their own HTTP(S) directory. The server and browser consume the same normalized snapshot as hosted mode. Authored membership determines discovery; hosted curation/visibility is never consulted. The SDK provides the shared file derivation function, while Lite owns atomic fetching, validation, caching and logo policy.

## Directory contract

For each enabled chain, the loader reads these JSON documents:

| Path | Shape and fields |
|---|---|
| `{chainId}/products.json` | Object keyed by product slug. Each product includes `name`, `entity` (entity key or keys), `vaults`; optional `deprecatedVaults`, `deprecationReason`, `description`, `portfolioNotice`, `tags`, `notExplorable`, `block`, `restricted`, and address-keyed `vaultOverrides`. Overrides support text, tags, country rules and `notExplorableLend/Borrow`. |
| `{chainId}/entities.json` | Object keyed by entity key. Profiles include `name`, `logo` filename, `description`, `url`, `addresses` (address-to-label map), and `social` URLs. These addresses drive governor/owner checks. |
| `{chainId}/points.json` | Array of `{name, logo, collateralVaults}` campaigns. |
| `{chainId}/earn-vaults.json` | Array of vault addresses or `{address, deprecated, deprecationReason, description, portfolioNotice, notExplorable, block, restricted, tags}` objects. |
| `{chainId}/assets.json` | Array of address or symbol/name matchers: `address`, `symbols`, `names`, `symbolRegex`, `nameRegex`, plus `block` / `restricted`. |
| `all/assets.json` | Global asset rules, combined with each chain's rules. |
| `logo/{filename}` | Entity/product/points images on the same origin. |

Collections may be omitted: HTTP 404 and HTTP 403 (the missing-key response from some S3/CDN hosts) resolve to `{}` for products/entities and `[]` for points/Earn/assets. Missing chain asset rules do not remove global asset rules, and vice versa. Explicit empty documents are also supported. Other HTTP errors, network failures and malformed content fail the refresh. File syntax retains the five-file authoring format; no generated normalized snapshot needs editing. [`tests/fixtures/static-labels.json`](../tests/fixtures/static-labels.json) is an executable example of the file contents.

Only HTTP(S) profile links and simple image filenames are accepted. Remote hosted label images must use `https://token-images.euler.finance`; static images may additionally use the configured source origin. Paths/credentials and lookalike hosts cannot bypass the image allowlist. The browser repeats the image check before rendering.

## Failure behavior

All six file reads resolve together, with absent files represented by empty collections. A failed or malformed refresh retains the complete last-known-good snapshot, including its rules. A cold start fails if any read has an error other than the supported absent-file responses. An absent-file response applies the empty collection on that refresh; there is no per-file stale grace period for 403/404. A source returning 403/404 for every file produces an empty snapshot, so configure a publicly readable source URL. Checkpoints are source-and-chain-specific, content-hashed and timestamped. Mount `GEO_POLICY_CACHE_DIR` on persistent storage for container replacements; the default `.data/geo-policies` only persists on the same filesystem. Stale fallback and failed checkpoint writes are logged for alerting.

Authored geo retains static country-group expansion and override semantics. This differs deliberately from hosted V3's cumulative rules. The contract test covers discovery, entities/authority addresses, points, logos, per-side flags, asset patterns, Earn restrictions and restart recovery.

## On-chain data

Static labels do not require running a V3 backend. A fork may use Euler's hosted quantitative endpoints for supported factory vaults, subject to API availability and access policy. Alternatively, configure `ONCHAIN_SDK_CHAINS` and the existing V3 feature gate for direct on-chain SDK reads. That mode has reduced history/activity/rewards coverage; static labels do not create an indexer or add support for arbitrary chains.

## Rollout boundary

Before switching production, compare authored and V3 membership, explorability, display content, geo decisions and full verification across enabled chains. Resolve unexplained differences; preserve public API behavior and measure revocation latency. On-chain governor verification remains active in hosted mode during this bake. SDK release/dependency changes and production cutover are deployment work. Persistent volumes, dedicated geo alerts and a compliance canary are optional operational hardening; fresh containers may fetch their initial rules from the configured upstream, as in the existing deployment model.
