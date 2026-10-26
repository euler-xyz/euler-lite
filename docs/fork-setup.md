# Fork setup: your own data sources

Lite supports an operator-owned V3 backend, operator-owned static labels, or static labels with V3 disabled. Label policy, quantitative data and subgraph discovery are separate choices. Direct subgraph URLs work without a catalog; a custom catalog is optional.

**The current Euler deployment needs no environment changes.** Keep its existing V3, labels and chain settings. `DISABLE_V3` defaults to `false`, and `LABELS_IMAGE_ORIGINS` can remain unset or blank. Neither setting needs to be added to the current deployment.

## Required versus optional settings

Starting from `.env.example` and the common app/RPC setup below, apply the source settings for the setup you choose. The examples also show optional defaults for clarity; you do not need to add every displayed variable.

| Setup | Required source settings | Vault data | Labels, discovery and country rules |
|---|---|---|---|
| Current Euler setup | No changes to the existing environment | Euler's V3 and configured RPCs | Euler's V3 |
| Your own V3 | Set `V3_API_URL` to your backend | Your V3, with RPC fallback by default | Your V3's published labels and live policies |
| Static labels with V3 | Set `LABELS_SOURCE=static` and `STATIC_LABELS_BASE_URL`; keep a configured `V3_API_URL` for quantitative reads | Your V3 or Euler's V3 | Your authored JSON files |
| Static labels without V3 | Set `LABELS_SOURCE=static`, `STATIC_LABELS_BASE_URL` and `DISABLE_V3=true` | RPC and configured subgraphs | Your authored JSON files |

| Setting | Requirement and default |
|---|---|
| `LABELS_SOURCE` | Defaults to `v3`. Explicitly set `static` when using your own files. |
| `DISABLE_V3` | Optional; defaults to `false`. Set `true` only for the setup without V3. |
| `LABELS_V3_SET`, `LABELS_V3_VERSION` | Optional; default to `public` and `latest`. Change only to select another published set/version. Ignored in static mode. |
| `LABELS_VAULT_TAG` | Optional; blank means no additional tag filter. |
| `LABELS_IMAGE_ORIGINS` | Optional; unset/blank is sufficient for Euler's V3 label image URLs, your configured V3 origin, and static-source images. Set only for hosted V3 label images on an additional CDN. It does not configure the labels source or extend static image rules. |
| `EULER_SDK_V3_API_KEY` | Required only if your V3 backend requires authentication. Otherwise leave blank. |
| `SERVER_VAULT_CACHE_SOURCE`, `NUXT_PUBLIC_BROWSER_VAULT_SOURCE` | Optional; both default to `fallback`. With `DISABLE_V3=true`, either `fallback` or `onchain` works; `v3` is invalid. |
| `ONCHAIN_SDK_CHAINS` | Required for every enabled deprecated chain using hosted labels. Keep existing entries; static labels do not require them for label verification. See [Deprecated chains](#deprecated-chains). |
| `DEPRECATED_CHAINS` | Optional status override; the chain manifest can supply deprecated status. Keep the current deployment's chain configuration. |
| `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL`, `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL` | Optional; set only to use your own manifest or ABI source. Otherwise the configured Euler interfaces branch supplies them. |

## Common setup

Use Node 24.22.1 (see `.nvmrc`) and npm 11.20.0 ([installation](../README.md#1-clone-and-install)), install the locked dependencies with `npm ci`, and copy `.env.example` to `.env`. Apply one of the configurations below. Values under `.example` are placeholders to replace with your own services.

```dotenv
# Set to your app's public URL (localhost for development).
NUXT_PUBLIC_APP_URL=http://localhost:3000
# Required: one RPC URL for every enabled chain.
RPC_URL_1=https://rpc.operator.example
# Choose direct subgraph URLs or a custom catalog below.
# Required for wallet connection; read-only browsing can omit it.
NUXT_PUBLIC_APP_KIT_PROJECT_ID=your-reown-project-id
```

Configure an RPC for every chain you serve. A chain must also be supported by the pinned SDK and AppKit network registry and have valid deployed Euler contracts; static labels cannot add arbitrary-chain support. See [Adding a chain](./adding-a-chain.md).

Lite admits deployments per chain before constructing browser SDK providers. If a usable manifest contains a missing or incomplete chain deployment, that chain is excluded while valid chains remain available. A present but invalid row can retain its cached addresses only within the bounded stale window; a removed row is excluded. Set the manifest's `viemName` when multiple network definitions share a chain ID. Browser and server SDKs use that selection, and both use the configured ABI source.

Run `npm run dev` for local development. For a deployment, run `npm run build`, then `node .output/server/index.mjs` with the environment supplied to the server. Restart the server after changing these settings. Lite requires its Nitro server for the internal proxies and runtime configuration; serving only the generated HTML is not the deployment described here.

## Your own subgraphs

Lite's browser reads use `/api/internal/proxy/subgraph/{chainId}`. Server SDK reads use the same source resolver directly. Both support explicit per-chain URLs; a catalog is optional metadata for discovering those URLs, not a requirement for running your fork.

Resolution follows this order for each chain:

1. `SUBGRAPH_DISABLED_<chainId>=true` disables subgraph reads, including explicitly configured URLs.
2. A nonempty `SUBGRAPH_URL_<chainId>` selects that endpoint.
3. Otherwise, a nonempty `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` selects that endpoint. Despite its prefix, this compatibility variable is read only on the server.
4. Otherwise, a nonempty `SUBGRAPH_CATALOG_URL` selects the chain's stable `euler-simple` record, unless `SUBGRAPH_CATALOG_DISABLED=true`.
5. Without a catalog URL or either explicit disable, the **server SDK** can use the published SDK's bundled Euler endpoint. The **browser proxy** instead reports a missing source.

**`SUBGRAPH_CATALOG_DISABLED=true` prevents both catalog resolution and bundled server SDK subgraph fallback, while retaining explicit URLs.** Leaving `SUBGRAPH_CATALOG_URL` blank alone does not prevent that server fallback. Empty URL variables mean unset; a missing, retired, invalid or unavailable opted-in catalog entry does not fall back to a bundled endpoint. The resolver can reuse a last-good catalog snapshot for up to seven days from the last successful fetch during refresh failures; see [Catalog cache and query checks](./sdk-integration.md#subgraph-catalog-resolution).

### Direct URLs without Euler subgraph fallback

In your copied `.env` and any deployment environment, first remove **all** copied `SUBGRAPH_URL_*` and `NUXT_PUBLIC_SUBGRAPH_URI_*` assignments pointing to Euler. The shipped `.env.example` contains explicit Euler URLs, and disabling the catalog does not disable those explicit URLs. Add only your intended endpoints:

```dotenv
# Direct-only subgraph resolution; no catalog or bundled server SDK fallback.
SUBGRAPH_CATALOG_URL=
SUBGRAPH_CATALOG_DISABLED=true
# Repeat for each chain that needs indexer-backed discovery.
SUBGRAPH_URL_1=https://subgraph.operator.example/mainnet/query
NUXT_PUBLIC_SUBGRAPH_URI_1=
# Leave unset/false for chains with an endpoint; true overrides the URL above.
SUBGRAPH_DISABLED_1=false
```

Replace the placeholder URL with your compatible subgraph. An unconfigured chain's subgraph reads fail explicitly rather than reaching a bundled Euler endpoint. This does not disable the chain's RPC or V3 reads. If you intentionally disable subgraph discovery on one chain, set `SUBGRAPH_DISABLED_<chainId>=true`; account and vault-type flows that require discovery will be unavailable.

### Custom catalog instead of per-chain URLs

Remove the copied Euler URL assignments as described above, then select your catalog:

```dotenv
SUBGRAPH_CATALOG_URL=https://config.operator.example/subgraphs/catalog.json
SUBGRAPH_CATALOG_DISABLED=false
# Unset both aliases for every chain whose endpoint should come from the catalog.
SUBGRAPH_URL_1=
NUXT_PUBLIC_SUBGRAPH_URI_1=
SUBGRAPH_DISABLED_1=false
```

The catalog must follow [the v1 contract and validation rules](./sdk-integration.md#subgraph-catalog-resolution), contain your intended endpoints, and advertise both `account-vault-discovery` and `vault-factory-lookup`. Merely hosting a catalog yourself does not make its listed endpoints operator-owned. Public catalog entries use HTTPS without URL credentials, query strings or fragments; explicit operator URL overrides follow the separate trusted configuration path. No official catalog is fetched implicitly.

To pin one chain while using the catalog for others, set its `SUBGRAPH_URL_<chainId>` to your endpoint. That pin wins even if the catalog retires the corresponding entry. Use the per-chain disable when you need to suppress a pin as well. A successful retirement of a catalog-selected chain stops that source without resurrecting a bundled endpoint.

These settings isolate **subgraph** resolution only. Configure [your V3](#your-own-v3), or [static labels without V3](#static-labels-without-v3), and review [other external services](#other-external-services) for RPC fallbacks, labels, deployment/ABI sources, rewards and other SDK defaults. `DISABLE_V3` does not disable subgraphs; subgraph controls do not disable V3. Catalog membership does not enable RPC chains or change `ONCHAIN_SDK_CHAINS` or chain lifecycle policy. Restart Lite after changing the environment.

## Your own V3

```dotenv
# Required to select your backend instead of Euler's.
V3_API_URL=https://v3.operator.example
# Required only if your backend requires authentication; server-only.
EULER_SDK_V3_API_KEY=your-server-api-key
# Optional defaults; omit these if the defaults match your setup.
DISABLE_V3=false
LABELS_SOURCE=v3
LABELS_V3_SET=public
LABELS_V3_VERSION=latest
SERVER_VAULT_CACHE_SOURCE=fallback
NUXT_PUBLIC_BROWSER_VAULT_SOURCE=fallback
```

Use the backend root URL, without a trailing `/v3`: the SDK and proxies append API paths. This must be an Euler V3-compatible service, not an arbitrary JSON API. It must provide the quantitative endpoints you enable, published Public Labels versions and metadata, and live visibility, governance and geo-policy endpoints. A publication selector alone does not isolate those live policies.

`V3_API_URL` takes precedence over `EULER_SDK_V3_API_URL`, then `NUXT_PUBLIC_V3_API_URL`. Remove unused aliases to avoid selecting a different backend accidentally. Keys use `V3_API_KEY`, then `EULER_SDK_V3_API_KEY`, then `EULER_V3_API_KEY`; never put keys in public variables or URLs. Browsers use Lite's same-origin proxy, and the configured upstream and key stay on the server.

`LABELS_V3_SET` selects a metadata set published by your V3. `LABELS_V3_VERSION` selects `latest` or a published immutable version; unknown sets/versions fail instead of falling back to Euler's public set. `LABELS_VAULT_TAG` can additionally narrow discovery and new-target suggestions, without changing verification, held positions or direct access.

### Images

`LABELS_SOURCE` and `STATIC_LABELS_BASE_URL` select the labels source; static labels already support logos hosted alongside their files. `LABELS_IMAGE_ORIGINS` is an optional allowlist for hosted V3 label images on an additional CDN. It does not replace those source settings or apply to static images.

Return public HTTP(S) URLs in V3 label metadata. The UI and public vault metadata automatically accept Euler's V3 label image URLs (`https://v3.euler.finance/v3/images/labels/{slug}`) and the origin of your configured custom V3. The retired `token-images.euler.finance` host is rejected and those avatars show initials. **Leave `LABELS_IMAGE_ORIGINS` unset or blank for those URLs, or when using static labels with logos on the static source's origin.** Only configure it when hosted label images use a separate CDN outside those accepted hosts:

```dotenv
# Optional: needed only for hosted V3 label images on these additional origins.
LABELS_IMAGE_ORIGINS=https://images.operator.example,https://cdn.operator.example
```

Use origins only, with no path, credentials, query or fragment. This setting does not rewrite image URLs or change which vaults are trusted. Hostname lookalikes are rejected. Image hosts must be publicly reachable by browsers; do not return private backend URLs as logos. Use HTTPS for remote images: the browser's content security policy allows HTTPS and same-origin images, even though server-side static-file fetching also supports HTTP.

Chain and oracle-provider logos use the public base returned by your V3's `GET /v3/images` endpoint as `{ "data": { "publicBaseUrl": "https://images.operator.example/v3/images" } }`. That public base must use HTTPS. If it is unavailable, chain logos use bundled fallbacks and oracle-provider logos are omitted.

### Deprecated chains

For hosted labels, every enabled chain marked `deprecated` in the chain manifest or in `DEPRECATED_CHAINS` must also be listed in `ONCHAIN_SDK_CHAINS`. For example, if your manifest marks enabled chain 146 deprecated:

```dotenv
ONCHAIN_SDK_CHAINS=146
```

The optional `DEPRECATED_CHAINS` variable can add deprecated status; it is not required when your manifest already supplies it. These chains use V3 metadata with on-chain governor/owner verification. Other enabled chains use V3 assessments even when their quantitative reads use RPC. Keep the explicit chain entry even if you globally select on-chain reads. Static labels bypass this hosted-label check and retain authored membership and country rules.

## Your own static labels with V3

Keep the V3 settings above, or use `V3_API_URL=https://v3.euler.finance` if you deliberately want Euler's quantitative data, and select your files:

```dotenv
# Required to select your authored files.
LABELS_SOURCE=static
STATIC_LABELS_BASE_URL=https://labels.operator.example
# Optional; false is the default.
DISABLE_V3=false
```

`LABELS_V3_SET` and `LABELS_V3_VERSION` are ignored in static mode. All Lite consumers, including its SDK instances and public metadata API, use the same authored snapshot. Hosted V3 visibility is not imported into it. Static mode uses authored country-rule semantics and on-chain governor/owner verification.

Serve these JSON files and images from the configured directory:

```text
labels/
  1/products.json
  1/entities.json
  1/points.json
  1/earn-vaults.json
  1/assets.json
  all/assets.json
  logo/curator.svg
```

Repeat the chain directory for every enabled chain. Products/entities are objects; points, earn-vaults and assets are arrays. At least one of each chain's products/entities files must return readable JSON. An intentionally empty `{}` is supported; both files returning 403/404 is a configuration error. Optional missing files become empty collections. A failed refresh retains the complete previous snapshot when one exists.

See [Static label authoring](./static-labels.md) for field definitions and failure behavior. The [fixture](../tests/fixtures/static-labels.json) shows each collection's shape; split its collections into the corresponding files and replace the illustrative addresses with deployed vaults and their governing entities. A product's entity addresses must match the relevant on-chain governor/owner for verification.

Static logos use simple filenames such as `curator.svg`, resolved under `logo/`. They can also use absolute HTTP(S) URLs on the static source's origin. Serve the directory without URL credentials, query tokens or fragments. These files are fetched by the server; their logos must also be reachable by browsers.

## Static labels without V3

```dotenv
# Required for static labels without V3.
LABELS_SOURCE=static
STATIC_LABELS_BASE_URL=https://labels.operator.example
DISABLE_V3=true
# Optional: the default fallback value also works with V3 disabled.
SERVER_VAULT_CACHE_SOURCE=onchain
NUXT_PUBLIC_BROWSER_VAULT_SOURCE=onchain
```

`DISABLE_V3` is the explicit opt-out. It takes precedence over the `EULER_SDK_DISABLE_V3` alias. It works even if `.env.example` still contains a V3 URL. Leaving `V3_API_URL` blank alone is not an opt-out: hosted labels and optional utilities otherwise retain the Euler default.

With this option, Lite disables V3 adapters and rejects `/api/internal/v3/*` requests locally. It skips V3 image discovery, the V3 token-list contribution, V3 pricing and intrinsic APY. Prices use available on-chain oracle paths, and ERC-20 decimals still come from RPC. History, assessments and other V3-only capabilities are unavailable; SDK reward adapters can still use configured direct providers. Both `fallback` and `onchain` data-source settings are supported; selecting `v3` alongside the opt-out is a configuration error.

This disables V3, not every external service. Configure the remaining sources below for your deployment.

## SDK settings versus Lite settings

Lite replaces the SDK's labels service so its UI, API and SDK cannot silently use different labels. Setting SDK label environment variables alone therefore does not select Lite's labels source.

| Concern | Lite deployment | Standalone SDK |
|---|---|---|
| V3 backend | `V3_API_URL` and aliases above | `config.v3ApiUrl` or `EULER_SDK_V3_API_URL` |
| Static labels | `LABELS_SOURCE=static` and `STATIC_LABELS_BASE_URL` | Supply an application-owned `IEulerLabelsService` through `servicesOverrides.eulerLabelsService`; the application owns file loading and validation |
| Chain deployments | `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` | `config.deploymentsUrl` or `EULER_SDK_DEPLOYMENTS_URL` |
| V3 opt-out | `DISABLE_V3` covers Lite routes and its SDK utilities | `config.disableV3` controls SDK adapters; configure optional pricing, token-list and intrinsic-APY services separately |

The following standalone SDK example selects V3, labels and deployment sources only; it does not isolate subgraph or other SDK defaults. Lite's `SUBGRAPH_*` controls belong to Lite, so consult the configuration documentation for your installed SDK version when configuring subgraphs directly.

A standalone SDK using your V3 for quantitative data and an application-owned labels service can be constructed with:

```ts
import { buildEulerSDK, type IEulerLabelsService } from '@eulerxyz/euler-v2-sdk'

export function createSdk(eulerLabelsService: IEulerLabelsService) {
  return buildEulerSDK({
    config: {
      rpcUrls: { 1: 'https://rpc.operator.example' },
      v3ApiUrl: 'https://v3.operator.example',
      deploymentsUrl: 'https://config.operator.example/EulerChains.json',
    },
    servicesOverrides: { eulerLabelsService },
  })
}
```

Pass your implementation of `IEulerLabelsService`; this example does not implement a static-file loader. The service must satisfy the installed SDK's labels contract, including data fetching, logo resolution and label population. See the [SDK labels documentation](https://github.com/euler-xyz/euler-sdks/blob/main/packages/euler-v2-sdk/docs/labels.md) for custom service guidance. Lite's static-file loading, validation, atomic checkpoints and V3 opt-out guards belong to Lite.

## Other external services

Owning V3 and labels does not automatically replace these sources:

| Source | How to configure it |
|---|---|
| Chain manifest and runtime ABIs | Set `NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL` and `NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL` to your files. Otherwise Lite uses the selected branch of Euler's interfaces repository. |
| RPC | Set `RPC_URL_<chainId>`. Wallet transports can also use the network's public RPC fallback. |
| Subgraphs | Choose [direct URLs or an optional custom catalog](#your-own-subgraphs). Use the explicit controls above to prevent bundled subgraph fallback. |
| Swap quotes | Configure `SWAP_API_URL` for your compatible swap service. See the SDK integration docs for the swap flow. |
| Extra token lists | `NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL` and `NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL` replace those sources; the latter is a directory serving `tokenlists-{chainId}.json`. Merkl reward tokens are another independent source. |
| Rewards and external migrations | Review the reward-provider flags in `.env.example` and the Aave/Morpho integrations for the features you enable. These providers are separate from V3. |
| Wallet connection and Pyth | Reown/AppKit and connected wallets make their own requests. Pyth updates use Lite's server proxy and require the corresponding configuration. |
| Screening, geo, terms and branding | Configure your screening service, edge country source, terms and branding URLs. Production screening requirements remain enforced; see [Address screening](./address-screening.md) and [Geo-blocking](./geo-blocking.md). |

If you retain Euler's chain manifest, its live status changes still apply to your enabled chains. Use your own valid manifest when your supported-chain lifecycle differs. These overrides do not remove SDK/network support requirements or protocol verification checks.

## Verify the setup

1. Start the server and check for `labels-config` errors. Chain checks follow manifest admission and deployment visibility, so excluded chains are not diagnosed as active label configuration errors. Messages name settings and chain IDs without printing configured URLs or credentials.
2. Open the app and select each configured chain. Confirm the intended products, labels and governor/owner verification; confirm country rules and any deployment tag filter.
3. Inspect the app's `/api/internal/public-labels?chainId=1` response in browser developer tools. Check your expected publication or authored content. `source=static` identifies authored files; `source=v3-metadata` identifies deprecated-chain metadata. Assessed V3 bundles may omit `source` or set it to `v3`. Do not treat a successful `/healthz` check as proof that labels are available.
4. Check logos both in the UI and in `/api/public/metadata?chainId=1`. Set `LABELS_IMAGE_ORIGINS` only for hosted label images on additional CDN origins; Euler V3 label images, your configured V3 origin and static-source images require no extra setting.
5. With `DISABLE_V3=true`, confirm V3 requests receive a local 503 and no V3 upstream request is made. Verify RPC browsing and token decimals, and expect V3-only sections to be unavailable.
6. For direct-only subgraphs, verify all explicit URL assignments belong to your intended services and `SUBGRAPH_CATALOG_DISABLED=true`. For catalog mode, verify a configured chain resolves from your catalog and an omitted/retired chain fails rather than selecting a bundled endpoint. Observe upstream requests at your own service; the browser only sees Lite's proxy.
7. Restart once to check the runtime environment. If using disk checkpoints, mount `GEO_POLICY_CACHE_DIR` on persistent storage for recovery across container replacements.

Labels configuration failures return HTTP 503 with `data.code=LABELS_CONFIGURATION_ERROR` and a setting-specific `data.message`. The UI tells the user to contact the app operator. Fix the configuration and restart; repeated retries cannot fix an invalid setting. An ordinary upstream outage retains the retry message and follows the source's cache policy.
