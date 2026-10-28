# Address Screening

Connect-time wallet screening for Euler Lite and first-party `*.euler.finance` SPAs. VPN usage is audit metadata; only the address-screening verdict gates access.

For geographic restrictions see [Geo-Blocking](./geo-blocking.md). For transaction policy after connect, see [Transaction Building](./transaction-building.md).

## Intent

A connected wallet must not become user-visible until data-v3 compliance returns an explicit clean verdict for that address. Screening is **not** repeated during reviewed execution.

```text
wagmi address change
        │
        ▼
useAddressScreen.screenConnectedAddress
        │
        ├─ detectVpn()          → boolean | null  (audit only)
        └─ screenAddress(...)   → POST /api/internal/screen-address
                │
                ▼
        screenAddressUpstream   → POST data-v3 /v3/compliance/address-screening
                │
        ┌───────┴────────┐
        │ restricted     │ clean
        ▼                ▼
   disconnect +     screenedAddress = address
   BlockedAddressModal
   useWagmi.address / isConnected stay unset
```

## Connect-time gate

| Module | Role |
| --- | --- |
| `composables/useWagmi.ts` | Watches the raw wagmi address; `address` / `isConnected` stay unset until `isAddressScreened` |
| `composables/useAddressScreen.ts` | Module-scoped verdict so every consumer agrees; generation counter drops stale in-flight results |
| `services/vpn.ts` | Optional client VPN probe |
| `services/screening.ts` | Browser POST; any non-ok / non-explicit-clean response is restricted |
| `server/api/internal/screen-address.post.ts` | Rate limit 10/60s, validate `0x` + 40 hex, proxy upstream |
| `server/utils/screening.ts` | Fail-closed upstream client |

`useWagmi` also routes ENS through the screened address so wallet-tied queries do not run before a clean verdict.

A restricted address disconnects the wallet and opens `BlockedAddressModal`. Closing it navigates to the deployment default page. Disconnect without a new address resets the screening, VPN, and country caches.

Client timeout: `WALLET_SCREENING_TIMEOUT_MS` (10s). Abort or throw → restricted.

## Request / response

Lite client body:

```json
{ "address": "0x…", "vpnIsUsed": true }
```

`vpnIsUsed` is `true`, `false`, or `null`. Missing, invalid, failed, or unsupported VPN measurements are `null`, never a fabricated `false`.

Lite response:

```json
{ "addressIsSuspicious": true }
```

`addressIsSuspicious !== false` is treated as restricted, including a malformed JSON body.

The server forwards `{ address, chain: "all", vpnIsUsed }` to data-v3. `chain: "all"` is explicit so TRM coverage does not depend on the upstream default.

Success envelope required from upstream (`data.*`): `address`, `addressIsSuspicious`, `screenedAt`, `resolvedChain`, `cached`, `ruleVersion`. Any other 2xx, a partial envelope, or a verdict echoing a different address is suspicious.

Invalid Lite body → HTTP 400 `Invalid address`.

Because first-party sibling SPAs call this path, keep the request/response contract backward-compatible. It stays under `/api/internal/` on purpose: `/api/public/` would advertise it to external integrators.

## VPN audit metadata

VPN evidence does **not** block connect. `useAddressScreen` always continues to `screenAddress`, including when the probe returns `true` or fails.

`deriveVpnIsUsed(event, body.vpnIsUsed)`:

1. A strict client `true` is additional positive evidence.
2. Otherwise use `getEdgeContext(event).vpnIsUsed`.
3. Client `false` / invalid values cannot clear a trusted edge `true`.
4. No positive signal and no edge evidence → `null`.

Only the `cloudflare` preset supplies VPN headers (`x-is-vpn` / `x-is-proxy-or-vpn` on the **request**). `window.__APP_CONFIG__.vpnDetection` is `true` only then; other presets skip the client probe.

The client probe is `HEAD /` reading the **response** header `x-is-vpn`. `server/middleware/cors.ts` does not set that response header — it only echoes `x-country-code`. Treat a client `true` as extra signal when an edge transform exposes the header; the authoritative Cloudflare evidence is still the request context on `POST /api/internal/screen-address`.

`geo-gate.ts` logs `VPN/proxy detected` when `edge.vpnIsUsed === true`. It does not block the request.

## Fail-closed configuration

| Config | Non-production | `DOPPLER_ENVIRONMENT=prd` |
| --- | --- | --- |
| Both `ADDRESS_SCREENING_URI` and `ADDRESS_SCREENING_API_KEY` unset | Disabled — every address passes; logs `screening disabled` | Fail closed (missing secrets, not an opt-out) |
| Only one var set | Fail closed | Fail closed |
| URI not `https:` (except `http://localhost` / `127.0.0.1`) | Fail closed — key must not travel without TLS | Fail closed |
| Upstream non-200, timeout, redirect, malformed envelope | Fail closed | Fail closed |

Redirects are refused (`redirect: 'error'`) so Node cannot replay the API key across a cross-origin redirect.

## CORS, cache, rate limit

`server/middleware/cors.ts` allows `https://euler.finance` and `https://*.euler.finance` **only** for `POST /api/internal/screen-address`. Configured `CORS_ALLOWED_ORIGINS` / `NUXT_PUBLIC_APP_URL` still apply via the regular allowlist. No other internal route gets this exception.

`server/plugins/sensitive-route-cache.ts` forces `Cache-Control: no-store` (plus CDN variants) on this path.

Rate limit: 10 requests / 60s, same budget table as [Architecture](./architecture.md#rate-limiting).

Logs hash the address (`hashIdentifier`); do not add raw addresses to screening log lines.

## Reviewed execution does not re-screen

`features/reviewed-execution/policy/engine.ts` `SUBJECT_CONCERNS.account` is `[]`. There is no `wallet-screening` concern. Preparation does not call `screenAddress` or `detectVpn`.

Connect-time gating already hid a restricted wallet from `useWagmi.address`. Derived EVC sub-accounts are bound into the reviewed request but are not screened as separate wallets.

## Troubleshooting

- **Wallet connects then immediately disconnects:** upstream returned suspicious, non-200, or the client treated a timeout as restricted. Check `screen-address` warn logs (hashed address) and `ADDRESS_SCREENING_*`.
- **Every address passes in staging, none in production:** both env vars unset. Production fails closed; other envs opt out.
- **VPN true in Cloudflare logs but `vpnIsUsed: null` upstream:** client probe skipped or response header absent; confirm the **request** still carries `x-is-vpn` / `x-is-proxy-or-vpn` on the screening POST (`EDGE_PROVIDER=cloudflare`).
- **Sibling SPA 403:** origin is not `https://*.euler.finance` and not on `CORS_ALLOWED_ORIGINS`.
- **Local screening against a local upstream:** `http://localhost` / `127.0.0.1` only; any other http URI fails closed.

## Tests

- `tests/composables/useAddressScreen.test.ts` — generation races; VPN never gates disconnect vs allow
- `tests/services/screening.test.ts` / `tests/services/vpn.test.ts` — client POST body and probe skip
- `tests/server/screen-address.test.ts` — envelope, `chain: "all"`, VPN merge, TLS URI
- `tests/reviewed-execution/preparation-service.test.ts` — no `screenAddress` / `detectVpn` during prepare
