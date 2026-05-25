# Forked execution recordings

This suite records real UI transaction execution against a mainnet Anvil fork.
It extends the existing parity scenario format with a connected injected wallet,
fork seeding, SDK `query*` call recording, raw API response capture, visible
`data-*` tag snapshots, and post-transaction portfolio captures.

## Current status

The scenario file covers the supported transaction-type target set in dry-run
validation. `swap-from-wallet` is listed as unsupported because Lite has no
regular wallet-to-wallet swap screen. Live fork recording requires a running
Anvil fork, a Lite dev server pointed at that fork, and a funded `FORK_RPC_URL`.

## Run

Start Anvil at the pinned fixture block:

```sh
anvil --fork-url "$FORK_RPC_URL" --fork-block-number 25159633 --auto-impersonate --port 8545
```

Start Lite with the fork as chain 1. Wallet reads, transactions, and browser
vault data go through the fork RPC:

```sh
RPC_URL_1=http://127.0.0.1:8545 \
SWAP_API_URL=https://swap-dev.euler.finance \
NUXT_PUBLIC_SWAP_API_URL=https://swap-dev.euler.finance \
NUXT_PUBLIC_BROWSER_VAULT_SOURCE=onchain \
SERVER_VAULT_CACHE_SOURCE=onchain \
DISABLE_SERVER_VAULT_CACHE=true \
NUXT_PUBLIC_EXECUTION_RECORD_SDK_QUERIES=true \
npm run dev -- --host 127.0.0.1 --port 3001
```

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
  --swap-api-url https://swap-dev.euler.finance
```

Targeted group runs use `--group <id>`. The suite validates global
transaction-type coverage, so a focused group can exit nonzero even when every
scenario in that group passes.

Scenario-specific discovery mocks belong in `tests/execution/scenarios.json`
with the scenario that needs them.

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
  scenario.
- `report.md`: a short human-readable summary with transaction hashes.
- `report.html`: a drill-down report with scenario details, captures,
  sidecar links, transaction hashes, and embedded videos.
- `videos/<scenario-id>.webm`: one Playwright recording per executed
  scenario. The recorder keeps the page open for 2500 ms after the final
  capture so the last rendered state is visible in the video. Pass
  `--video-tail-ms <ms>` to adjust that wait or `--no-video` to skip recording.

`execution:suite` writes a top-level `report.html`, `report.md`, and
`summary.json` in addition to each group's artifact directory.
