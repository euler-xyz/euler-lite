# Public API

Endpoints under `/api/public/` are intentionally reachable from any origin (no CORS allowlist) and are intended to be consumed by external integrators.

The `/api/public/` path prefix is the contract: any handler placed below it in `server/api/public/` automatically receives `Access-Control-Allow-Origin: *` via `server/middleware/cors.ts`. Do not put internal endpoints under this prefix.

All public endpoints are rate-limited per client IP and return JSON.

---

## `GET /api/public/is-known`

Answers whether a given vault address is considered verified by this app — the same verdict the client UI applies before rendering a vault as a known market.

A vault is **verified** when ALL of the following hold:

- It appears in one of the trust anchors:
  - `products.json` labels under any product's `vaults[]` or `deprecatedVaults[]` (covers both EVK and Securitize vaults).
  - `earn-vaults.json` labels (active or deprecated entry).
  - The on-chain set returned by `escrowedCollateralPerspective.verifiedArray()` for the chain (escrow vaults are trusted unconditionally — no governor check applies).
- AND its on-chain governor matches the product's declared entity:
  - For EVK / Securitize vaults: `vault.governorAdmin` must be in the `addresses` map of one of the product's declared entities. If the vault's oracle router has a non-zero governor, that governor must also match.
  - For Earn vaults that ALSO appear under a product: `vault.owner` must match a declared entity address. Earn vaults that only appear in `earn-vaults.json` (no product) are trusted on the strength of the labels alone.

The same governor check applies to active and deprecated vaults — deprecation does not change the verification rule. The `notExplorable` flag does **not** change verification either: vaults hidden from Explore are still verified.

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
| `502`  | All upstream sources (labels endpoint, chains config, RPC proxy) failed and no stale cache is available. |

### Caching

The server maintains a per-chain in-memory verified set with a 5-minute TTL and stale-while-revalidate fallback. Back-to-back lookups for the same chain are served from memory. Upstream refreshes happen at most once every 5 minutes per chain.

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
| `productId` | string   | no       | Product slug from `products.json` (e.g. `euler-prime`). When set, only entries whose `productId` equals this value are returned. Combines with `addresses`: an address that resolves but belongs to a different product returns `null`. `[a-zA-Z0-9_-]+`, max 100 chars. |

### Response

Status `200`, JSON object keyed by EIP-55 checksum addresses.

**Lookup mode** (`addresses` provided): one entry per input address. Unknown addresses (not in any labels file and not in the on-chain escrow perspective) resolve to `null`.

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
  productId: string | null                   // product slug from products.json that owns this vault; null for escrow and for vaults with no product entry
  asset: {
    address: string                          // checksummed
    symbol: string
    name: string
    decimals: number
    url: string | null                       // same logoURI /api/token-list serves; null when no source carries it
  } | null
  entity: {
    name: string
    logo: string                             // full URL composed from the labels CDN config
    description: string | null
  } | null
}
```

### Resolution rules

Label-derived display fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`) are sourced from labels regardless of verification state — they are authoritative content set by the team that listed the vault. Per-vault `vaultOverrides` take precedence over product- or earn-entry-level values. The on-chain ERC-20 `name` is only a fallback when no label name is defined.

`entity` is the only field gated by the `is-known` verdict. It identifies the declared product entity whose `addresses` contain the vault's `governorAdmin` (or `owner` for Earn). It is `null` when the vault would not be `is-known: true`:

- **Verified non-escrow vault** (governor match against a declared entity): `entity` is populated with the matched entity from `entities.json`, with `logo` composed as a full URL.
- **Unverified vault** (in labels but governor mismatch, active or deprecated): `entity` is `null`. Other label fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`, `deprecated`) are still populated. `asset` and `type` are also populated.
- **Escrow vault** (`escrowedCollateralPerspective.verifiedArray()`): `name` is the constant `"Escrowed collateral"`; all label-derived fields, `productId`, and `entity` are `null`; `deprecated: false`; `asset` comes from the snapshot when the address is in the referenced subset, otherwise `null`.

The `deprecated` boolean distinguishes deprecated-but-otherwise-fine vaults from genuinely unverified ones. The same governor check applies to deprecated and active vaults — deprecation only sets the `deprecated` flag and (typically) populates `deprecationReason`.

Earn vaults that are in `earn-vaults.json` but not in any product entry resolve with `description` / `portfolioNotice` / `deprecationReason` from the earn entry; `productId` and `entity` are `null` because there is no declared product.

When a product declares multiple entities and more than one matches the on-chain governor (`governorAdmin` for EVK/Securitize, `owner` for Earn), the first match in declared-key order wins.

### Errors

| Status | Cause                                                                    |
|--------|--------------------------------------------------------------------------|
| `400`  | Missing/invalid `chainId`, `chainId` not supported, >100 addresses, or a malformed address. |
| `429`  | Rate limit exceeded for this client IP.                                  |
| `502`  | Required upstream sources (`products.json`, `entities.json`, vault snapshot) failed and no stale cache is available. |

### Caching

Per-chain in-memory map with a 5-minute TTL, in-flight de-dup, and stale-while-revalidate fallback. The underlying vault snapshot is warm-refreshed every 5 minutes by the app's warm-cache plugin, so steady-state requests are served from memory.

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
    "productId": "euler-prime",
    "asset": {
      "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "symbol": "WETH",
      "name": "Wrapped Ether",
      "decimals": 18,
      "url": "https://token-icons.llamao.fi/icons/tokens/1/0xc02…?h=48&w=48"
    },
    "entity": {
      "name": "Euler DAO",
      "logo": "https://raw.githubusercontent.com/euler-xyz/euler-labels/refs/heads/master/logo/euler.svg",
      "description": "Euler DAO is responsible for the governance of the Euler protocol."
    }
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
- Shared verification rule (also used by the client UI): `entities/vault/governor-verification.ts`
- CORS bypass for the `/api/public/` prefix lives in `server/middleware/cors.ts`.
- Escrow vaults are read via an `eth_call` to `escrowedCollateralPerspective.verifiedArray()`. The perspective address is looked up from `EulerChains.json` (served by `/api/euler-chains`), and the RPC endpoint is taken from `RPC_URL_<chainId>`. Products and earn-vault label files are fetched via internal self-calls to `/api/labels/<file>` to reuse the labels endpoint's own cache and validation. Entity logo URLs are composed from `NUXT_PUBLIC_CONFIG_LABELS_BASE_URL` (or the `REPO`/`REPO_BRANCH` fallback) so they match the URL the app itself renders.
