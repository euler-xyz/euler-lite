# Golden canary: SDK tx-plan calldata

**This is a version canary, not a correctness suite.** The SDK tests each
`executionService.plan*` builder comprehensively in its own repo
(`euler-xyz/euler-sdks`, `test/executionService.test.ts`); duplicating that here
would be redundant. This suite exists to catch the one thing the SDK's own tests
can't: an SDK version bump (dependabot, or the preview-SDK path) that silently
changes the byte-for-byte calldata a Lite user would sign.

It runs a handful of representative operations — one per encoder family (plain
vault op, borrow, repay, migration, swap, leverage) — and for each:

1. Runs the SDK `executionService.plan*` method against deterministic args, then
   `resolveRequiredApprovals`.
2. Reduces the plan to a canonical `[{to, data, value, evcBatch}]` tx list
   (see `normalize.ts`) — the view a wallet would sign: ERC20 `approve` calls +
   the `EVC.batch(items)` call. Permit2 sign items are dropped (off-chain).
3. Asserts that list byte-for-byte against a committed fixture under `plans/`.

If a fixture fails, an SDK change moved the calldata: review the diff and
regenerate with `npm run test:golden:update`. Deliberately narrow — expand it
only if there's a specific calldata path worth pinning across upgrades.

These tests run as part of the normal suite (`npm run test:run`) — no separate
config or setup.

## Running

```sh
# Run just the golden suite.
npm run test:golden

# Regenerate the plan fixtures from the current SDK output, then review the diff
# before committing. Use this whenever a deliberate builder change moves calldata.
npm run test:golden:update
```

Outside update mode a missing fixture is a hard failure rather than a silent
self-approval, so the suite can never "pass" in CI by minting its own baseline.

## Swap-quote fixtures

The swap-quote tests load real quotes saved under `fixtures/*.json`. They were
fetched once via the SDK's `SwapService` against `https://swap-dev.euler.finance`
with the real Ethereum mainnet Euler deployment addresses (so the SDK's
verifier-address + verifier-data validations pass).

Regenerate when the swap API or the SDK validation rules change:

```sh
npm run test:golden:fetch-fixtures
```

To point the fetcher at a different swap API URL:

```sh
GOLDEN_SWAP_API_URL=https://swap.example.org npm run test:golden:fetch-fixtures
```

Each fixture is a `{ request, quote }` pair — the request is preserved so the
test can recover bigint inputs (`amount`, `currentDebt`) via the `$bigint`
reviver in `load-fixture.ts`.

## Addresses & scenarios

`harness.ts` pins the real Ethereum mainnet Euler core/periphery addresses (evc,
permit2, swapper, swapVerifier, accountLens) and real mainnet ERC20s — the swap
quotes are validated against these. Vaults are placeholder `0xa00…` addresses
(the swap API doesn't validate them), chosen so they stand out in calldata.

Scenarios are tuned to bypass external dependencies the planners would otherwise
touch: Pyth feed fetch (no controllers / no liability vault), swap verifier RPC
(the `SkipMin`/`*Max` verify types in the fixtures), and previewWithdraw (the
seeded account uses shares == assets).

## Extending

For each new operation:

1. Pick the SDK planner and populate `buildSdkAccount({positions})` with the
   sub-account state it needs (e.g. `planRepayFromWallet` reads `position.asset`
   and `position.borrowed` via `account.getPosition(...)`).
2. Call `expectGoldenPlan('<name>', plan)` in the test.
3. Run `npm run test:golden:update` to capture `plans/<name>.json`, review the
   generated calldata, and commit it.
