---
name: claude-review-security
description: Review PR changes for web security issues in the euler-lite frontend
---

# Security Review

Review this PR's changes for web security issues in the euler-lite frontend.

## Context

euler-lite is a DeFi frontend that interacts with Ethereum wallets and external RPCs. Security-sensitive surfaces:
- Environment variables / chain config exposed to the client bundle
- User wallet addresses and transaction data rendered in the UI
- External RPC endpoints used for on-chain reads
- Geo-blocking and screening enforced on the server (not just client)
- `window.__CHAIN_CONFIG__` — chain configuration injected server-side; must never contain secrets

## Instructions

### Step 1: Get the diff

```bash
git diff origin/$BASE_REF...HEAD
```

### Step 2: Check against these criteria

**Environment Variable & Secret Exposure**
- No API keys, RPC auth tokens, or secrets assigned to `NUXT_PUBLIC_*` env vars (those are client-exposed)
- No new keys added to `window.__CHAIN_CONFIG__` or any other `window.*` injection — recent fix (Dec 2024) explicitly removed RPC URLs from this object
- `runtimeConfig.public.*` only contains truly public, non-sensitive values
- Server-only secrets accessed via `runtimeConfig.*` (non-public), never in `pages/` or `composables/` that run client-side

**XSS / Injection**
- No use of `v-html` on user-provided or contract-derived data (token names, vault descriptions)
- No `innerHTML` / `document.write` / `eval` in any JS/TS files
- External URLs (e.g. token icon URLs from on-chain data) not injected as `src` without validation — malicious SVGs can execute scripts
- User-input strings (amounts, addresses) sanitised before display if rendered in a context that could escape text nodes

**Geo-blocking / Access Control**
- New pages or transaction flows consult `useGeoBlock` — server-side blocking is the source of truth but client must not expose restricted UI
- No new client-side-only blocking logic that could be bypassed — geo check must be server-enforced for any restricted operation
- Routes that should be protected are not accidentally accessible without the guard composable

**RPC / Wallet Surface**
- RPC URLs are not logged to console or included in error messages surfaced to users
- No RPC endpoint constructed from user-supplied input without validation
- Wallet connection flows don't expose private keys or mnemonics in state/logs
- `simulateContract` used before `writeContract` to catch reverts before wallet prompt — prevents confusing failed transactions

**Dependency / Supply Chain**
- New `npm` packages are well-known and actively maintained — flag any obscure packages touching crypto/wallet code
- No `postinstall` scripts in newly added packages that could execute arbitrary code

### Step 3: Classify findings

- `🚨 CRITICAL:` — secret exposure risk, XSS vector, geo-blocking bypass, RPC URL leakage to client
- `⚠️ WARNING:` — potential exposure path that requires specific conditions, missing `simulateContract`, missing guard
- `💬 SUGGESTION:` — defence-in-depth improvement, better validation

### Step 4: Post findings

Hand off all findings to /inline-pr-comments. Include a summary of the security surface reviewed.
