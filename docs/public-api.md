# Public API

Endpoints under `/api/public/` are intentionally reachable from any origin (no CORS allowlist) and are intended to be consumed by external integrators.

The `/api/public/` path prefix is the contract: any handler placed below it in `server/api/public/` automatically receives `Access-Control-Allow-Origin: *` via `server/middleware/cors.ts`. Do not put internal endpoints under this prefix.

All public endpoints are rate-limited per client IP and return JSON.

---

## `GET /api/public/is-known`

Answers whether a given vault address is considered verified by this app — the same verdict the client UI applies before rendering a vault as a known market.

A vault is **verified** through one of two paths:

- **Escrow path**: the address appears in the on-chain set returned by `escrowedCollateralPerspective.verifiedArray()` for the chain. Escrow vaults are trusted unconditionally; no product, entity, or governor check applies.
- **Label + authority path**:
  - EVK / Securitize vaults must be assigned to a Public Labels V3 product.
  - The product must declare at least one `entity` key.
  - The vault's `governorAdmin` must be in the `addresses` map of one of the product's declared entities. If the vault's oracle router has a non-zero governor, that governor must also match.
  - A product whose `entity` field is empty or omitted is treated as having no on-chain authority to claim the vault — every vault under such a product is unverified, regardless of its `governorAdmin`.

Standalone Earn vaults published in the V3 inventory are trusted on the strength of that label. If an Earn vault is assigned to a product, the verifier applies an owner/entity match against that product.

For EVK / Securitize vaults, the same governor check applies to active and deprecated vaults — deprecation does not change the verification rule. The `notExplorable` flag does **not** change verification either: vaults hidden from Explore are still verified.

### Scope of `is-known`

`is-known` reflects **label / governance consistency only** — that an EVK / Securitize vault's on-chain governor still matches the entity declared by its product label, that an Earn vault is trusted by its Earn label entry, or that the vault is in the on-chain escrow perspective. It does **not** assert:

- smart-contract configuration safety (LTVs, oracle setup, IRM, hooks)
- absence of risk signals (oracle staleness, asset health, liquidity, market conditions)
- visibility decisions (whether the vault is shown on lend / borrow / explore pages)

This endpoint deliberately does not encode configuration-safety or risk-context signals. Integrators that need those signals should consume dedicated risk or market-data endpoints instead of inferring them from `is-known`.

See [vault-labels-and-verification.md](./vault-labels-and-verification.md) for how the label sources themselves are structured.

### Request

| Param       | Type     | Required | Description                                                                 |
|-------------|----------|----------|-----------------------------------------------------------------------------|
| `chainId`   | integer  | yes      | EVM chain ID (e.g. `1` for mainnet).                                        |
| `addresses` | string   | no       | Comma-separated list of vault addresses. Max 100. Lowercase or valid EIP-55 checksum accepted; mixed-case inputs must have a correct checksum. Omit to return the full known set ("list mode"). |

### Response

Status `200`, JSON object keyed by EIP-55 checksum addresses.

**Lookup mode** (`addresses` provided) — one entry per input address mapped to `true` / `false`:

```json
{
  "0xAbC…": true,
  "0xDeF…": false
}
```

**List mode** (`addresses` omitted) — every known address on the chain mapped to `true`:

```json
{
  "0xAbC…": true,
  "0xDeF…": true
}
```

Addresses are validated via viem's `isAddress` (strict EIP-55 checks) and normalized to checksum form before comparison. All-lowercase hex inputs are accepted; mixed-case inputs must carry a valid EIP-55 checksum or the request is rejected with `400`. All-uppercase inputs are rejected. Keys in the response always use the checksum form.

### Errors

| Status | Cause                                                                    |
|--------|--------------------------------------------------------------------------|
| `400`  | Missing/invalid `chainId`, `chainId` not supported by this deployment, >100 addresses, or a malformed address. |
| `429`  | Rate limit exceeded for this client IP.                                  |
| `502`  | Public Labels V3, chains config, or RPC failed and no bounded stale cache is available. |

### Caching and propagation

- **Response header**: `Cache-Control: public, max-age=30, stale-while-revalidate=30`. CDNs and browsers can cache for 30 s and serve stale for another 30 s while revalidating.
- **Server-side cache**: per-chain in-memory verified set with a 5-minute TTL. A warm-cache process rebuilds every cache entry every 5 minutes on its own schedule (force-refresh, ignores fresh entries), so the cache is always continuously fresh in steady state.
- **In-flight dedup**: concurrent cold requests for the same chain collapse onto a single upstream pass.
- **Propagation**: on-chain governor changes and `version=latest` Public Labels updates typically propagate within **~5 minutes**. Public Labels, the vault snapshot, and the verified-set cache are warmed on the same cycle.
- **Stale fallback**: during upstream outages, the bridge serves only the last-known-good data within each cache's configured stale ceiling before returning a hard error.

### Rate limit

100 requests per minute per client IP.

### CORS

`Access-Control-Allow-Origin: *`. Preflight (`OPTIONS`) responds with `204` and `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`.

### Examples

Single address:

```bash
curl 'https://<host>/api/public/is-known?chainId=1&addresses=0x1234567890123456789012345678901234567890'
```

```json
{ "0x1234567890123456789012345678901234567890": false }
```

Batch lookup:

```bash
curl 'https://<host>/api/public/is-known?chainId=1&addresses=0xAAA…,0xBBB…,0xCCC…'
```

```json
{
  "0xAAA…": true,
  "0xBBB…": false,
  "0xCCC…": true
}
```

From the browser (verifying CORS):

```js
const res = await fetch(
  'https://<host>/api/public/is-known?chainId=1&addresses=0x1234567890123456789012345678901234567890'
)
const map = await res.json()
```

---

## `GET /api/public/metadata`

Returns display metadata for one or many vaults on a chain, in a uniform shape across vault flavours (EVK, Securitize, Earn). Escrow vaults are rendered as a special-case EVK with the constant name `"Escrowed collateral"`.

This endpoint answers "what is this vault?" — the trust verdict (`is-known`) is intentionally not part of the response. Callers compose the two endpoints when they need both.

### Request

| Param       | Type     | Required | Description                                                                 |
|-------------|----------|----------|-----------------------------------------------------------------------------|
| `chainId`   | integer  | yes      | EVM chain ID (e.g. `1` for mainnet).                                        |
| `addresses` | string   | no       | Comma-separated list of vault addresses. Max 100. Same casing rules as `/is-known`. Omit to return every known vault on the chain ("list mode"). |
| `productId` | string   | no       | Public Labels V3 product ID (e.g. `euler-prime`). When set, only entries whose `productId` equals this value are returned. Combines with `addresses`: an address that resolves but belongs to a different product returns `null`. `[a-zA-Z0-9_-]+`, max 100 chars. |

### Response

Status `200`, JSON object keyed by EIP-55 checksum addresses.

**Lookup mode** (`addresses` provided): one entry per input address. Unknown addresses (not in Public Labels and not in the on-chain escrow perspective) resolve to `null`.

**List mode** (`addresses` omitted): every known vault on the chain. No `null` values.

Each `VaultMetadata` entry has the shape:

```ts
interface VaultMetadata {
  chainId: number
  address: string                            // checksummed
  type: 'evk' | 'securitize' | 'earn'        // escrow is a special-case EVK; see name override
  name: string                               // never null — falls back to on-chain ERC-20 name only when labels carry no name
  description: string | null
  portfolioNotice: string | null
  deprecationReason: string | null
  deprecated: boolean                        // true if listed under any product's deprecatedVaults or earn entry has deprecated: true
  governanceLimited: boolean                 // true when the owning product has the "governance limited" tag. False for vaults without a product.
  productId: string | null                   // Public Labels product ID; null for escrow and standalone vaults
  asset: {
    address: string                          // checksummed
    symbol: string
    name: string
    decimals: number
    url: string | null                       // same logoURI /api/internal/token-list serves; null when no source carries it
  } | null
  entities: Array<{
    name: string
    logo: string                             // hosted URL from the Public Labels entity profile
    description: string | null
    url: string | null                       // entity website; only set when http(s) URL
  }>                                         // empty array when no entity matches (escrow, unverified, or no product); usually 0 or 1 entry, but can be N when a product declares multiple entities that all match the on-chain governor
}
```

### Resolution rules

Label-derived display fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`) are sourced from Public Labels V3 regardless of verification state. Vault fields take precedence over product fields. Standalone Earn metadata comes from its V3 inventory row. The on-chain ERC-20 `name` is only a fallback when no published label name is defined.

`entities` identifies every declared product entity whose `addresses` contain the vault's `governorAdmin` (or `owner` for an Earn vault that also appears under a product). A product can declare multiple entity keys, and more than one of those can match — the array preserves the declared-key order. Resolution depends on the vault's verification state:

- **Verified non-escrow vault** (governor match against at least one declared entity): `entities` contains every matching Public Labels entity profile, including its hosted `logo` URL. Usually 1 entry, but can be N.
- **Unverified vault** (in labels but governor mismatch, or in a product that declares no entity): `entities` is `[]`. Other label fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`, `deprecated`) are still populated. `asset` and `type` are also populated.
- **Standalone Earn vault**: `entities` is `[]`.
- **Escrow vault** (`escrowedCollateralPerspective.verifiedArray()`): `name` is the constant `"Escrowed collateral"`; all label-derived fields and `productId` are `null`; `entities` is `[]`; `deprecated: false`; `asset` comes from the snapshot when the address is in the referenced subset, otherwise `null`.

The `deprecated` boolean distinguishes deprecated-but-otherwise-fine vaults from genuinely unverified ones. For EVK / Securitize vaults, the same governor check applies to deprecated and active vaults — deprecation only sets the `deprecated` flag and (typically) populates `deprecationReason`.

Standalone Earn vaults resolve with `description`, `portfolioNotice`, and `deprecationReason` from the V3 inventory row and return `productId: null`, `entities: []`.

#### `entities` is not equivalent to `is-known`

`entities` answers "who manages this vault"; it is independent of `is-known`. An empty `entities` array does **not** mean the vault is unknown — escrow vaults and Earn vaults without a product entry return `entities: []` while still being `is-known: true`.

Use `/api/public/is-known` for the verification verdict. Use the non-`null` / `null` distinction on `/api/public/metadata` for metadata presence. A labeled EVK / Securitize vault with a governor mismatch can return `is-known: false` while still returning non-`null` metadata.

### Errors

| Status | Cause                                                                    |
|--------|--------------------------------------------------------------------------|
| `400`  | Missing/invalid `chainId`, `chainId` not supported, >100 addresses, or a malformed address. |
| `429`  | Rate limit exceeded for this client IP.                                  |
| `502`  | Required Public Labels V3, effective-policy, or vault-snapshot data failed and no stale cache is available. |

### Caching and propagation

Same shape as [`/is-known` caching](#caching-and-propagation):

- **Response header**: `Cache-Control: public, max-age=30, stale-while-revalidate=30`.
- **Server-side cache**: per-chain in-memory metadata map, 5-minute TTL.
- **Warm cycle**: the warm-cache plugin force-rebuilds the metadata map every 5 minutes on its own schedule, so a fresh entry is always available.
- **In-flight dedup**: concurrent cold requests for the same chain collapse onto a single upstream pass.
- **Propagation**: on-chain changes and label edits propagate within **~5 minutes**.
- **Stale fallback**: serves last-known-good data for up to 10 minutes past TTL during prolonged upstream outages.

### Rate limit

100 requests per minute per client IP. Independent of the `/is-known` limit.

### CORS

`Access-Control-Allow-Origin: *`. Same preflight behaviour as the rest of `/api/public/`.

### Examples

Lookup mode:

```bash
curl 'https://<host>/api/public/metadata?chainId=1&addresses=0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2'
```

```json
{
  "0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2": {
    "chainId": 1,
    "address": "0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2",
    "type": "evk",
    "name": "Euler Prime",
    "description": "A lending and borrowing market for stablecoin-denominated assets…",
    "portfolioNotice": null,
    "deprecationReason": null,
    "deprecated": false,
    "governanceLimited": false,
    "productId": "euler-prime",
    "asset": {
      "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "symbol": "WETH",
      "name": "Wrapped Ether",
      "decimals": 18,
      "url": "https://token-icons.llamao.fi/icons/tokens/1/0xc02…?h=48&w=48"
    },
    "entities": [
      {
        "name": "Euler DAO",
        "logo": "https://token-images.euler.finance/labels/euler",
        "description": "Euler DAO is responsible for the governance of the Euler protocol.",
        "url": "https://euler.finance"
      }
    ]
  }
}
```

List mode:

```bash
curl 'https://<host>/api/public/metadata?chainId=1'
```

---

## Implementation notes

- Handlers: `server/api/public/is-known.get.ts`, `server/api/public/metadata.get.ts`
- Verified-set builder + cache: `server/utils/verified-vaults.ts`
- Metadata builder + cache: `server/utils/vault-metadata.ts`
- Shared verification rule (also used by the client UI): `utils/vault/governor-verification.ts`
- CORS bypass for the `/api/public/` prefix lives in `server/middleware/cors.ts`.
- Escrow vaults are read via an `eth_call` to `escrowedCollateralPerspective.verifiedArray()`. The perspective address is looked up from `EulerChains.json` (served by `/api/internal/euler-chains`), and the RPC endpoint is taken from `RPC_URL_<chainId>`. Public endpoints use the same cached `getPublicEulerLabelsData()` source as the browser and vault snapshot; there are no internal self-HTTP label calls. Entity logo URLs come directly from Public Labels profiles.
