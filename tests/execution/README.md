# Forked execution recordings

This suite records real UI transaction execution against a mainnet Anvil fork.
It extends the existing parity scenario format with a connected injected wallet,
fork seeding, SDK `query*` call recording, raw API response capture, visible
`data-*` tag snapshots, and post-transaction portfolio captures.

## Coverage

The UI groups exercise supply, withdrawal, redemption, borrow, the four repayment
paths, collateral/debt swaps, same-asset collateral migration, Multiply with a
swap, cleanup, EulerEarn supply/withdrawal, and mature/early rEUL unlocks.
The `transferMin` cases include partial savings and collateral withdrawals, a
full Max redemption, and two withdrawals in one reviewed atomic batch.

`unsupportedTransactionTypes` describes gaps in this UI fixture: wallet swaps
have no regular screen, and same-asset debt migration/Multiply have no selected
UI market here. Standalone share transfer also needs a separate fixture; max
repayment cleanup does not establish transfer coverage. These are not unsupported
SDK operations. The supplemental
`execution:transfer-min` script exercises wallet swaps to the owner and another
recipient, plus an Aave USDT-to-EulerEarn USDC migration. It runs the real shared
requirement collector and snapshot loader, backed by fork contract reads, before
sending SDK plans and asserting receipt/balance results. It does not exercise the
complete browser review or policy pipeline for those supplemental cases.

Dry-run validation checks scenario declarations only. Execution coverage requires
successful receipts; UI success text or an approval alone is insufficient.
These Ethereum fixtures do not establish coverage for every chain, wallet type,
reward provider, migration connector, or asynchronously settled CoW order.

Live recording requires an archive-capable `FORK_RPC_URL`, a running Anvil fork,
and a local Lite server pointed at that fork. The fixture block must contain the
lenses and SwapVerifier named by the deployment manifest served by Lite.

## Run

Start Anvil at the pinned fixture block:

```sh
anvil --fork-url "$FORK_RPC_URL" --fork-block-number 26182477 --auto-impersonate --port 8545
```

Start Lite with the fork as chain 1. Wallet reads and transactions go through
the fork RPC; regular vault reads use the default fallback adapter chain
(V3 primary, on-chain secondary):

```sh
RPC_URL_1=http://127.0.0.1:8545 \
SWAP_API_URL=https://swap-dev.euler.finance \
NUXT_PUBLIC_SWAP_API_URL=https://swap-dev.euler.finance \
NUXT_PUBLIC_EXECUTION_RECORD_SDK_QUERIES=true \
npm run dev -- --host 127.0.0.1 --port 3001
```

For production-bundle validation, run `npm run build` and serve
`.output/server/index.mjs` with the same environment and `HOST=127.0.0.1 PORT=3001`.
Keep only the intended fork chain enabled. Use a disposable local configuration
with the terms gate disabled; accepting external service terms is outside these
transaction fixtures.

The public Anvil fixture account is configured with `wallet.resetCode: true`.
Setup clears its delegated mainnet bytecode **on Anvil only** to exercise an
ordinary EOA, and records the original bytecode in `run.json`. ERC-20 balances
are seeded by impersonated holder transfers. The signature preference is
`signatures-enabled`; swap scenarios set slippage through the form's actual
control so context changes cannot silently discard a storage preset.
The batch scenario enables Advanced mode through `user-settings` so its batch
controls are available.

Record:

```sh
npm run execution:record -- --scenario lend-supply-execute \
  --url http://127.0.0.1:3001 \
  --swap-api-url https://swap-dev.euler.finance
```

Run the full transaction suite:

```sh
npm run execution:suite -- \
  --url http://127.0.0.1:3001 \
  --swap-api-url https://swap-dev.euler.finance \
  --all-browser-rpc-to-anvil --headless
```

Run the supplemental `transferMin` checks on an independently started fork at the
same fixture block, or after the UI suite finishes. Do not run both against one
Anvil instance concurrently: UI groups revert snapshots between groups.

```sh
npm run execution:transfer-min -- \
  --url http://127.0.0.1:3001 \
  --anvil-rpc http://127.0.0.1:8546 \
  --output-dir artifacts/execution-recordings/sdk-transfer-min
```

This script rejects non-Anvil clients and a fork block that differs from the
fixture. Live swap quotes are simulated against the fork before submission;
upstream liquidity can differ from a pinned block. Its output files are
`wallet-swaps.json` and `earn-migration.json`, including verification modes,
required vaults, successful receipts, and received tokens/shares.

Targeted group runs use `--group <id>`. The suite validates global
transaction-type coverage, so a focused group can exit nonzero even when every
scenario in that group passes.

Scenario-specific discovery mocks belong in `tests/execution/scenarios.json`
with the scenario that needs them. Use `discoveryMocks.subgraph.accounts` to
declare indexed account rows that the fork cannot produce on demand; each entry
lists the owner account plus the sub-account/vault pairs to expose as deposits
or borrows. Use `subAccountIndex` for borrow positions when the UI path is
`/position/{index}`. Scenarios that start from a transaction form can set
`discoveryMocks.activation` to `afterFirstTransaction` so the synthetic rows
only appear after execution begins.

Validate the fixture and scenario coverage without connecting to Anvil or the
app:

```sh
npm run execution:record -- --dry-run
```

Artifacts are written to `artifacts/execution-recordings/<timestamp>/`:

- `run.json`: fixture metadata, seeded balances, action results, visible
  data-tag snapshots, optional vault snapshot path, and references to sidecar
  record files.
- `sdk-queries.jsonl`: deduplicated SDK `query*` call records and responses;
  `run.json` reports both unique records and total observed events.
- `network.jsonl`: raw API/swap network captures.
- `wallet-requests.jsonl`: injected wallet RPC requests, transaction hashes,
  and receipts. Transaction receipts with a non-success status fail the
  scenario. A scenario with a non-empty `covers` list also requires a successful
  execution call, excluding approvals, and idle wallet activity before the final
  capture. `requiredCalls` asserts decoded target/signature/count matches inside
  EVC batches; `requireAtomicExecution` requires one execution transaction.
  Withdrawal and redemption cases assert their distinct selectors so a partial
  withdrawal cannot count as full redemption. `run.json` checkpoints each finished
  scenario and includes its decoded `executionCalls`.
- `report.md`: a short human-readable summary with transaction hashes.
- `report.html`: a drill-down report with scenario details, captures,
  sidecar links, transaction hashes, and embedded videos.
- `videos/<scenario-id>.webm`: one Playwright recording per executed
  scenario. The recorder keeps the page open for 2500 ms after the final
  capture so the last rendered state is visible in the video. Pass
  `--video-tail-ms <ms>` to adjust that wait or `--no-video` to skip recording.

The recorder raises Anvil's block gas limit only for the large read-only
Multicall used to load the vault inventory. Wallet transactions remain capped
at the recorder's separate fork-only transaction gas limit.

`execution:suite` writes a top-level `report.html`, `report.md`, and
`summary.json` in addition to each group's artifact directory.

## CSP smoke checks

Run the production build (`npm run build` then `node .output/server/index.mjs`)
with the fork configuration above and add `--assert-csp` to `execution:record`
or `execution:suite`. Each scenario then records `security` in `run.json` and
fails if the app document lacks enforced CSP, any frame or popup reports a CSP
violation, or Coinbase `ClientAnalytics` appears. Transaction success and UI
assertions still apply independently. Request failures and page errors are
recorded for diagnosis; an aborted navigation is not itself a CSP violation.

Use an explicit local `NUXT_PUBLIC_APP_URL` and matching `CORS_ALLOWED_ORIGINS`
when running on a port outside the development defaults. Historical fork
fixtures require compatible deployment addresses and labels. A lens address
from a current registry may have no code at an old fork block. Check contract
code before running, and use matching metadata or a compatible fork block.
The fixture signer must also match its expected account type: a public test
address can have EIP-7702 delegated code on the fork, which changes Permit2
signature verification. Use a fresh test signer or restore its expected EOA
state only on the disposable fork. Unverified vaults need explicit scenario
actions for the risk prompt. See [CSP smoke testing](../../docs/csp-smoke-testing.md)
for browser controls and deployed wallet checks.
