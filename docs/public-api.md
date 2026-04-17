# Public API

Endpoints under `/api/public/` are intentionally reachable from any origin (no CORS allowlist) and are intended to be consumed by external integrators.

The `/api/public/` path prefix is the contract: any handler placed below it in `server/api/public/` automatically receives `Access-Control-Allow-Origin: *` via `server/middleware/cors.ts`. Do not put internal endpoints under this prefix.

All public endpoints are rate-limited per client IP and return JSON.

---

## `GET /api/public/is-known`

Answers whether a given vault address is considered verified by this app.

"Verified" means the vault is in the app's allowlist used to render markets and resolve unknown-vault prompts — specifically, it appears in one of:

- `products.json` labels under any product's active `vaults[]` (covers both EVK and Securitize vaults, since Securitize vaults are tracked alongside EVK in the same file).
- `earn-vaults.json` labels as an entry where `deprecated !== true`.
- The on-chain set returned by `escrowedCollateralPerspective.verifiedArray()` for the chain.

Deprecated vaults (in `products.deprecatedVaults[]` or earn entries with `deprecated: true`) are treated as **not verified**. The `notExplorable` flag does **not** change verification — vaults hidden from Explore are still verified.

See [vault-labels-and-verification.md](./vault-labels-and-verification.md) for how the label sources themselves are structured.

### Request

| Param       | Type     | Required | Description                                                                 |
|-------------|----------|----------|-----------------------------------------------------------------------------|
| `chainId`   | integer  | yes      | EVM chain ID (e.g. `1` for mainnet).                                        |
| `addresses` | string   | yes      | Comma-separated list of vault addresses. Max 100. Lowercase or valid EIP-55 checksum accepted; mixed-case inputs must have a correct checksum. |

### Response

Status `200`, JSON object mapping each input address (in EIP-55 checksum form) to `true` / `false`:

```json
{
  "0xAbC…": true,
  "0xDeF…": false
}
```

Addresses are validated via viem's `isAddress` (strict EIP-55 checks) and normalized to checksum form before comparison. All-lowercase hex inputs are accepted; mixed-case inputs must carry a valid EIP-55 checksum or the request is rejected with `400`. All-uppercase inputs are rejected. Keys in the response always use the checksum form.

### Errors

| Status | Cause                                                                    |
|--------|--------------------------------------------------------------------------|
| `400`  | Missing/invalid `chainId`, `chainId` not supported by this deployment, missing `addresses`, >100 addresses, or a malformed address. |
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

## Implementation notes

- Handler: `server/api/public/is-known.get.ts`
- Verified-set builder + cache: `server/utils/verified-vaults.ts`
- CORS bypass for the `/api/public/` prefix lives in `server/middleware/cors.ts`.
- Escrow vaults are read via an `eth_call` to `escrowedCollateralPerspective.verifiedArray()`. The perspective address is looked up from `EulerChains.json` (served by `/api/euler-chains`), and the RPC endpoint is taken from `RPC_URL_HTTP_<chainId>`. Products and earn-vault label files are fetched via internal self-calls to `/api/labels/<file>` to reuse the labels endpoint's own cache and validation.
