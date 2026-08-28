# Address Screening

Wallet addresses are screened once at connect time against the data-v3 compliance API. A restricted verdict disconnects the wallet and shows `BlockedAddressModal`. Forms never see an unscreened address: `useWagmi()` only exposes `address` / `isConnected` after a non-restricted verdict.

This is separate from [geo-blocking](./geo-blocking.md) (country / vault / asset rules). Screening answers “is this address restricted?”; geo-blocking answers “is this country allowed to use this vault or asset?”.

## Files at a Glance

| File | Role |
|------|------|
| `composables/useAddressScreen.ts` | Module-scoped verdict cache, generation-guarded connect flow, blocked modal |
| `composables/useWagmi.ts` | Watches the connector address, runs screening, gates `address` / `isConnected` |
| `services/screening.ts` | Client POST to `/api/internal/screen-address`; fail-closed on timeout / non-OK |
| `services/vpn.ts` | Client HEAD `/` for the origin `x-is-vpn` **response** header (see VPN below) |
| `server/api/internal/screen-address.post.ts` | Rate-limited proxy; validates `0x` + 40 hex; ignores body `vpnIsUsed` |
| `server/utils/screening.ts` | Upstream POST, TLS/config gates, verdict contract, VPN from **request** headers |
| `server/middleware/cors.ts` | Path-scoped CORS exception for first-party `*.euler.finance` SPAs |
| `server/plugins/sensitive-route-cache.ts` | Forces `Cache-Control: no-store` on this route |

## Connect-Time Flow

```text
wallet address changes
  → useWagmi watch
  → useAddressScreen.screenConnectedAddress
       1. detectVpn()            // client HEAD; body field is not authoritative
       2. screenAddress(address) // POST /api/internal/screen-address
  → restricted: disconnect + BlockedAddressModal, stay unscreened
  → clear: screenedAddress = address; useWagmi exposes address / isConnected
wallet disconnect
  → resetScreeningCache() (also clears VPN + country caches)
```

`useAddressScreen` is a module-level singleton. Every caller shares `screenedAddress` / `isScreening` so `useWagmi.isAddressScreened` cannot disagree with the modal owner.

A generation counter drops stale in-flight results when the address changes or screening is reset mid-flight.

Client timeouts are `WALLET_SCREENING_TIMEOUT_MS` (10 s) in `entities/tuning-constants.ts`. Timeout, network error, or a non-OK HTTP status all return **restricted** (`true`). The client treats any payload other than `addressIsSuspicious === false` as restricted.

## Reviewed Execution Does Not Re-Screen

Connect-time gating is the wallet-screening boundary. `features/reviewed-execution/policy/engine.ts` collects account subjects with **no** `wallet-screening` concern; `resolveAppPolicy` does not call `screenAddress` or `detectVpn`.

`useWagmi().address` is already `undefined` until screening passes, so a reviewed execution cannot be prepared for an unscreened EOA. Derived EVC sub-accounts are bound into the reviewed request but are not screened as separate wallets.

Do not add a second screening call inside preparation or pre-handoff: the connect-time cache plus the wagmi gate is the intended once-per-session check.

## Server Contract

`POST /api/internal/screen-address`

```json
{ "address": "0xabc…40hex" }
```

Optional body field `vpnIsUsed` is accepted by JSON parsing and **ignored**. VPN measurement is taken from Cloudflare-set request headers (below).

Response:

```json
{ "addressIsSuspicious": false }
```

`addressIsSuspicious: true` means the address is treated as restricted. The handler never throws for an upstream miss — it returns a boolean verdict. Invalid addresses (`400`) and rate-limit / CORS failures are the exceptions.

### Upstream

`server/utils/screening.ts` `POST`s `{ address, chain: "all", vpnIsUsed }` to `ADDRESS_SCREENING_URI` with `X-API-Key: ADDRESS_SCREENING_API_KEY`.

`chain` is sent as the literal `"all"` so TRM screens the address on every chain it supports in one request. Do not derive this from the UI’s selected network — a same-address hit on another chain must still flag the wallet.

Redirects are refused (`redirect: 'error'`). The restricted key must not follow a cross-origin redirect.

The documented success contract is **exactly HTTP 200** with a complete `data` envelope:

| Field | Type |
|-------|------|
| `data.address` | string, must match the requested address (case-insensitive) |
| `data.addressIsSuspicious` | boolean |
| `data.screenedAt` | string |
| `data.resolvedChain` | string |
| `data.cached` | boolean |
| `data.ruleVersion` | string |

A partial envelope, a non-200 (including other 2xx), a mismatched `data.address`, or `addressIsSuspicious !== false` all fail closed (`addressIsSuspicious: true`). Logs hash the address (`hashIdentifier`); they do not print the raw value.

Upstream fetch timeout is `UPSTREAM_FETCH_TIMEOUT_MS` (10 s).

### Configuration

| Env | Role |
|-----|------|
| `ADDRESS_SCREENING_URI` | data-v3 `POST /v3/compliance/address-screening` (must be `https://`, or `http://` loopback only) |
| `ADDRESS_SCREENING_API_KEY` | Restricted key with `compliance:screen`. Not `EULER_SDK_V3_API_KEY`. |
| `DOPPLER_ENVIRONMENT` | `prd` treats missing **both** vars as a failed secret injection (fail closed). Other environments treat missing **both** as “no provider” (every address passes) and log `address screening not configured — screening disabled`. |

Partial configuration (only one of URI / key) fails closed in every environment. A non-TLS URI fails closed so the restricted key is never sent in the clear.

Production must not run unscreened. Non-production operators who unset both vars should watch the screening-disabled log line.

## VPN Measurement

Two different headers, two different consumers — do not conflate them.

| Path | Source | Used for |
|------|--------|----------|
| Screening POST → upstream `vpnIsUsed` | Request headers `x-is-vpn` / `x-is-proxy-or-vpn` on the POST (`deriveVpnIsUsed`) | Compliance API payload |
| Client `detectVpn()` | Response header `x-is-vpn` on `HEAD /` | Sent in the client body, which the handler **does not read** |

`deriveVpnIsUsed`:

- Neither header present (or whitespace-only) → `null` (“not measured”), never a fabricated `false`.
- Either header has a comma/array token that trims to `"true"` (case-insensitive) → `true`.
- Headers present but not truthy → `false`.

Lite’s Nitro `cors.ts` does **not** set `x-is-vpn` on responses. The client HEAD depends on the Cloudflare edge exposing that response header. A HEAD timeout/error fail-closes `detectVpn()` to `true` and caches it for 5 minutes (`CACHE_TTL_5MIN_MS`).

Geo-gate logs the same request headers for monitoring and does not block on VPN (false-positive rate).

## CORS, Caching, Rate Limit

- **Same-origin** Lite calls work through the normal CORS allowlist (`CORS_ALLOWED_ORIGINS` / `NUXT_PUBLIC_APP_URL` / dev localhost).
- **First-party exception**: `https://euler.finance` and `https://*.euler.finance` may call **only** this path. Sibling SPAs (create / redemptions / maglev) have no Nitro of their own. Do not copy this exception onto other `/api/internal/*` routes. Keep the route under `/api/internal/` (not `/api/public/`) so it is not advertised to external integrators. Request/response shape changes must stay backward-compatible.
- **No-store**: `sensitive-route-cache.ts` forces no-store so a CDN cannot reuse a verdict.
- **Rate limit**: 10 requests / 60 s per IP (`label: 'screen-address'`). In production the limiter fail-closes with HTTP 403 when `CF-Connecting-IP` is absent.

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Every wallet blocked in production | Missing `ADDRESS_SCREENING_*`, non-https URI, or upstream timeout/non-200 |
| Every wallet allowed on a fork / preview | Both env vars unset and `DOPPLER_ENVIRONMENT !== prd` (expected opt-out) |
| Sibling SPA gets CORS 403 | Origin is not `https://*.euler.finance`, or it is calling a different internal path |
| VPN always `null` upstream | Cloudflare is not injecting `x-is-vpn` / `x-is-proxy-or-vpn` on the POST |
| `useWagmi().isConnected` stuck false | Screening still in flight, or the verdict was restricted |
| Reviewed-execution tests calling `screenAddress` | Preparation must not screen; assert `screenAddress` is not called |

Locally, leave both screening env vars empty to pass every address. To exercise fail-closed, set only one of the two vars or point `ADDRESS_SCREENING_URI` at `http://example.com`.
