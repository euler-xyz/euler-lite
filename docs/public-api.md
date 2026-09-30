# Public API

Endpoints under `/api/public/` are intentionally reachable from any origin (no CORS allowlist) and are intended to be consumed by external integrators.

The `/api/public/` path prefix is the contract: any handler placed below it in `server/api/public/` automatically receives `Access-Control-Allow-Origin: *` via `server/middleware/cors.ts`. Do not put internal endpoints under this prefix.

All public endpoints are rate-limited per client IP and return JSON.

---

## `GET /api/public/is-known`

Answers whether a given vault address is considered verified by this app — the same verdict the client UI applies before rendering a vault as a known market.

A vault is **verified** through one of these paths:

- **Escrow path**: the address appears in the on-chain set returned by `escrowedCollateralPerspective.verifiedArray()` for the chain. Escrow vaults are trusted unconditionally; no product, entity, or governor check applies.
- **V3 assessment path**: on assessed chains, the published effective visibility verdict is `visible` or `warning` and the vault has a managing entity. `hidden` and `pending_review` vaults are not verified, even when their display metadata is available.
- **Metadata-only or static path**: without a V3 verdict, the vault must have a qualifying label and the on-chain governor, router governor, or Earn owner must match a declared managing entity, according to the source's verification rules.

Deprecation does not change the verification rule. An independently non-explorable vault can still be verified; a V3 `hidden` visibility verdict cannot.

### Scope of `is-known`

`is-known` reflects the source's verification verdict or independent escrow membership. On V3-assessed chains, V3's effective visibility incorporates its own governance consistency decision; Lite does not repeat that check. It does **not** assert:

- smart-contract configuration safety (LTVs, oracle setup, IRM, hooks)
- absence of risk signals (oracle staleness, asset health, liquidity, market conditions)
- discovery eligibility (whether a verified vault is shown on lend / borrow / explore pages)

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

- **Response header**: up to `Cache-Control: public, max-age=30, stale-while-revalidate=30`. On V3-assessed chains, both cache windows shorten as the source verdict approaches its 15-minute expiry.
- **Server-side cache**: per-chain in-memory verified set with a 5-minute TTL, rebuilt on demand from the shared Public Labels bundle. A V3 verdict is usable only within 15 minutes of its source read, even when the derived set was rebuilt more recently.
- **In-flight dedup**: concurrent cold requests for the same chain collapse onto a single upstream pass.
- **Propagation**: Public Labels verdict and publication changes, and on-chain governor changes on fallback sources, typically propagate within **~5 minutes**. Public Labels and the vault snapshot are warmed; verified-set requests use those cached inputs.
- **Stale fallback**: during upstream outages, the bridge serves only the last-known-good data within each cache's configured stale ceiling. V3 verdicts additionally expire 15 minutes after the source read; after that, the bridge returns an error until a fresh read succeeds.

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
  }>                                         // V3 manager on assessed chains, matching on-chain authority on fallback sources; empty for escrow or unverified vaults
}
```

### Resolution rules

Label-derived display fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`) are sourced from Public Labels V3 regardless of verification state. Vault fields take precedence over product fields. Standalone Earn metadata comes from its V3 inventory row. The on-chain ERC-20 `name` is only a fallback when no published label name is defined.

`entities` identifies the managing entity supplied by V3 on assessed chains. On metadata-only and static sources, it identifies declared entities whose addresses match the on-chain governor or Earn owner. Resolution depends on the vault's verification state:

- **Verified non-escrow vault**: `entities` contains the V3 managing entity on assessed chains, or every matching declared entity on fallback sources, including hosted logos.
- **Unverified vault**: `entities` is `[]`. Other label fields (`name`, `description`, `portfolioNotice`, `deprecationReason`, `productId`, `deprecated`) remain available when published; `asset` and `type` are also populated.
- **Standalone Earn vault**: V3-assessed rows use their published manager when verified; fallback-source entries without a declared manager return `entities: []`.
- **Escrow vault** (`escrowedCollateralPerspective.verifiedArray()`): `name` is the constant `"Escrowed collateral"`; all label-derived fields and `productId` are `null`; `entities` is `[]`; `deprecated: false`; `asset` comes from the snapshot when the address is in the referenced subset, otherwise `null`.

The `deprecated` boolean is independent of verification and typically accompanies `deprecationReason`.

Standalone Earn vaults resolve with `description`, `portfolioNotice`, and `deprecationReason` from the V3 inventory row and return `productId: null`. Verified V3 rows include their published managing entity when available.

#### `entities` is not equivalent to `is-known`

`entities` answers "who manages this vault"; it is independent of `is-known`. An empty `entities` array does **not** mean the vault is unknown — escrow vaults and Earn vaults without a product entry return `entities: []` while still being `is-known: true`.

Use `/api/public/is-known` for the verification verdict. Use the non-`null` / `null` distinction on `/api/public/metadata` for metadata presence. A V3 hidden or pending-review vault, or a fallback-source vault with an authority mismatch, can return `is-known: false` while still returning non-`null` metadata.

### Errors

| Status | Cause                                                                    |
|--------|--------------------------------------------------------------------------|
| `400`  | Missing/invalid `chainId`, `chainId` not supported, >100 addresses, or a malformed address. |
| `429`  | Rate limit exceeded for this client IP.                                  |
| `502`  | Required Public Labels V3, effective-policy, or vault-snapshot data failed and no stale cache is available. |

### Caching and propagation

- **Response header**: `Cache-Control: public, max-age=30, stale-while-revalidate=30`.
- **Server-side cache**: per-chain in-memory metadata map, 5-minute TTL.
- **Refresh**: requests rebuild an expired metadata map from the shared cached labels and vault inputs.
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
