# CSP smoke testing

Use a production Nuxt build for these checks. The dev server intentionally
allows same-origin frames and does not represent the deployed policy.

## Browser policy controls

```sh
npm run build
# Load your local environment and set the intended host/port before starting.
node --env-file=.env .output/server/index.mjs
npm run csp:controls -- --url http://localhost:3000
npm run csp:controls -- --url http://localhost:3000 --browser webkit
```

Install matching browser binaries with `npx playwright install chromium webkit`.
CI runs the Chromium controls after building the app.

The runner captures the target's enforced CSP and serves a disposable local
fixture with that unchanged policy. Nonce-authorized page scripts attempt eval,
Wasm compilation, workers, fetches, WebSockets, frames, form submission, and
base/object injection. Parser scripts without the correct nonce and inline
handlers must be blocked. Correctly nonced scripts, trusted dynamic scripts,
and same-origin fetches must succeed. Forbidden same-origin requests must not
reach the fixture server. The source HTML must have a fresh nonce on every
script and `Cache-Control: no-store`.

A separate fixture checks that the observer records violations in child frames
and popups and detects analytics in a popup that closes before the final
snapshot. The controls run in the page; `page.evaluate` only reads their result,
since Playwright evaluation bypasses page CSP.

These are policy enforcement tests. They do not prove wallet compatibility or
protection against malicious code already trusted by `strict-dynamic`.

## Deployed app and wallet readiness

Use an isolated Reown QA project with the exact preview origin allowlisted.
Set `APPKIT_PROJECT_ID` and `NUXT_PUBLIC_APP_URL` on that preview. If Doppler
provides runtime configuration, the preview's startup command can preserve
only those explicit overrides:

```text
./doppler run --preserve-env=NUXT_PUBLIC_APP_URL,APPKIT_PROJECT_ID -- /nodejs/bin/node .output/server/index.mjs
```

Verify the running deployment uses that command and emits both values in
`window.__APP_CONFIG__`.

```sh
npm run csp:probe -- \
  --url 'https://YOUR-PREVIEW/explore?network=1' \
  --expect-selector 'button:has-text("Total supply")' \
  --walletconnect --wait 30000
```

`--walletconnect` requires an enabled pairing QR/link. It does not approve a
wallet session. `--expect-selector` adds a visible UI success assertion; without
it the probe only checks a successful HTML response and security observations.
Use an app route such as `/explore` for wallet checks; `/` can show onboarding.
`--screenshot /tmp/csp-smoke.png` saves the final browser state.

The probe observes the context's frames and popups, reports CSP violations,
Coinbase `ClientAnalytics`, page errors, failed requests and WebSocket errors,
and fails if CSP is absent, the page fails, or a requested UI assertion fails.
Network diagnostics are not automatically classified as CSP failures.

Complete the wallet matrix separately: WalletConnect pairing, reload,
reconnect, disconnect and chain change; Coinbase with and without its extension;
Base Account popup; email/social login and session restoration. Use designated
QA accounts and keep real signing under the account owner's control. WebKit
automation does not substitute for a physical iOS/mobile wallet test.

## Fork transactions and edge behavior

Run the [execution recorder](../tests/execution/README.md) against a disposable
Anvil fork with `--assert-csp`. Require successful receipts and the scenario's
post-transaction UI assertions, as well as zero CSP failures. A clean CSP log
alone does not mean a transaction succeeded.

Test public RPC fallback by failing the proxy in an isolated browser context,
and exercise swap quotes, rewards, Pyth updates, error decoding and CoW reads.
Distinguish endpoint/CSP reachability from full transaction or order execution.

Repeat the app probe on the same commit behind the deployment's Cloudflare
configuration. A direct origin hostname does not exercise Cloudflare's script
injection, analytics, challenge paths or nonce propagation. Check each injected
script and retain its network/console evidence.
