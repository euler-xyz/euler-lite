# Static label authoring

`LABELS_SOURCE=v3` is the default hosted mode. It reads published metadata, live visibility, governance addresses and geo policies from V3, without consulting any labels repository.

For complete environment examples, SDK/Lite setting differences, and remaining external services, see [Fork setup](./fork-setup.md).

Hosted deployments select metadata with `LABELS_V3_SET` (default `public`) and `LABELS_V3_VERSION` (default `latest`, or an immutable publication key such as `v20260911011146353` or `test-2026-06-30`). The SDK resolves `latest` within the selected set and applies that set/version to vault, product and entity metadata. Server caches separate upstream, set, chain and version. Unknown sets or unavailable publications fail rather than falling back to public. The internal endpoint's explicit `version` query still overrides the deployment default for diagnostics; the label set is server-configured. Draft selectors are not supported. Restart the service after changing these variables.

These settings select published metadata, not an isolated staging system: visibility, geo policies, governance addresses and live platform fields continue to use the configured V3 backend. Static mode ignores the V3 label selectors.

Forks select `LABELS_SOURCE=static` and set `STATIC_LABELS_BASE_URL` to their own HTTP(S) directory. The server and browser consume the same normalized snapshot as hosted mode. Authored membership determines discovery; hosted curation/visibility is never consulted. The SDK provides the shared file derivation function, while Lite owns atomic fetching, validation, caching and logo policy.

`LABELS_VAULT_TAG` optionally narrows discovery and new-target suggestions to an exact tag. Static product tags apply to all members; vault overrides and Earn entries can add tags. Blank leaves authored discovery unchanged. Full labels, geo rules and direct access remain available regardless of tag selection. See [deployment tag filtering](./vault-labels-and-verification.md#discovery-page-filtering).

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

Collections may be omitted: HTTP 404 and HTTP 403 (the missing-key response from some S3/CDN hosts) resolve to `{}` for products/entities and `[]` for points/Earn/assets. **Both chain products and chain entities missing is a configuration error.** At least one of these files must be readable; an intentionally empty object `{}` is valid. Missing chain asset rules do not remove global asset rules, and vice versa. Other HTTP errors, network failures and malformed content fail the refresh. File syntax retains the five-file authoring format; no generated normalized snapshot needs editing. [`tests/fixtures/static-labels.json`](../tests/fixtures/static-labels.json) is an executable example of the file contents.

Only HTTP(S) profile links and simple image filenames are accepted. Static images resolve against the configured source's `logo/` directory and may use that source's origin. Euler's V3 label image URLs (`https://v3.euler.finance/v3/images/labels/{slug}`) are accepted. The retired `token-images.euler.finance` host is rejected. For hosted V3 labels, the UI and public metadata API also accept the configured custom V3 origin and any explicitly configured `LABELS_IMAGE_ORIGINS` (comma-separated HTTP(S) origins). Credentials and lookalike hosts cannot bypass the image allowlist. Static snapshots are normalized with the same image rules on the server and in the browser; `LABELS_IMAGE_ORIGINS` does not extend static image rules. See [Vault Labels → Label logos](./vault-labels-and-verification.md#label-logos).

## Failure behavior

All six file reads resolve together, with individually absent files represented by empty collections. A failed or malformed refresh retains the complete last-known-good snapshot, including its rules. This also applies when both products and entities disappear. Without a valid previous snapshot, both products and entities returning 403/404 fails with a configuration error; other HTTP errors, network failures and malformed content also fail the load. An individual absent-file response applies the empty collection on a successful refresh; there is no per-file stale grace period. Checkpoints are source-and-chain-specific, content-hashed and timestamped. Mount `GEO_POLICY_CACHE_DIR` on persistent storage for container replacements; the default `.data/geo-policies` only persists on the same filesystem. Stale fallback and failed checkpoint writes are logged for alerting.

Authored geo retains static country-group expansion and override semantics. This differs deliberately from hosted V3's cumulative rules. The contract test covers discovery, entities/authority addresses, points, logos, per-side flags, asset patterns, Earn restrictions and restart recovery.

## On-chain data

Static labels do not require running a V3 backend. A fork may use its own V3 or Euler's hosted quantitative endpoints for supported factory vaults, subject to API availability and access policy. For a deployment without V3, set `DISABLE_V3=true` alongside static labels. Lite disables V3 adapters, its V3 proxy, image discovery, and optional V3 pricing, token-list and intrinsic-APY reads. On-chain pricing and token-decimal resolution remain available. This mode has reduced history/activity/rewards coverage; static labels do not create an indexer or add support for arbitrary chains. Other external services remain separately configured; see [Fork setup](./fork-setup.md#other-external-services).

## Rollout boundary

Before switching production, compare authored and V3 membership, explorability, display content, geo decisions and full verification across enabled chains. Resolve unexplained differences; preserve public API behavior and measure revocation latency. On-chain governor verification remains active in hosted mode during this bake. SDK release/dependency changes and production cutover are deployment work. Persistent volumes, dedicated geo alerts and a compliance canary are optional operational hardening; fresh containers may fetch their initial rules from the configured upstream, as in the existing deployment model.
