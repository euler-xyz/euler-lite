# Golden tests: legacy → SDK plan-builder parity

For each operation type exposed by `composables/useEulerTx.ts`, these tests:

1. Run the **legacy** `useEulerOperations` builder, imported from a parallel git
   worktree that pins the pre-migration `HEAD` (where `composables/useEulerOperations/*`
   still exists).
2. Run the **SDK** `executionService.plan*` method against the matching args, then
   `resolveRequiredApprovals` to expand approval intents into concrete approve calls.
3. Reduce both plans to a canonical `[{to, data, value, evcBatch}]` tx list
   (see `normalize.ts`) and assert byte-for-byte equality.

The "canonical tx list" is the post-approval-expansion view a wallet would
sign: ERC20 `approve` calls + the `EVC.batch(items)` call. Permit2 sign items
are dropped (off-chain signatures, not txs).

## Setup

```sh
# 1. Create the legacy worktree pinned to the last commit before the SDK
#    migration. Path is sibling to this repo, expected by vitest.golden.config.ts.
git worktree add ../euler-lite-sdk-exec-legacy HEAD

# 2. Share node_modules so the legacy worktree resolves the same deps
#    (viem, vue, @eulerxyz/euler-v2-sdk, etc.).
ln -s "$(pwd)/node_modules" ../euler-lite-sdk-exec-legacy/node_modules

# 3. Share the generated .nuxt/tsconfig.json so vitest's TS resolver finds the
#    parent the legacy tsconfig extends from.
ln -s "$(pwd)/.nuxt" ../euler-lite-sdk-exec-legacy/.nuxt

# 4. Run the tests.
npm run test:golden
```

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

## How the import resolution works

`vitest.golden.config.ts` aliases `~` and `@` to the **legacy** worktree (so
any `import '~/X'` inside a legacy source file resolves to the file in that
worktree). The test file itself reaches into the SDK via the normal
`@eulerxyz/euler-v2-sdk` package import, which is identical across worktrees.

Aside from `~`, the only extra alias is `@golden` → `tests/golden`, used to
pull in the SDK harness + normalizer from the main worktree without ambiguity.

## What's covered

Each `describe` block targets one operation in `useEulerTx.ts`. Some are
intentionally skipped where the SDK migration changed batch shape or
ordering vs the legacy builder — those are kept in-file with a comment
explaining the specific divergence, so the parity audit stays visible
rather than getting lost.

Swap-quote operations (`planSwapCollateral`, `planSwapDebt`, etc.) are
listed as `it.todo` placeholders. Filling them in requires building a
deterministic `SwapApiQuote` fixture (verifier address, multicall items,
slippage bounds) that both implementations accept verbatim — that's a
follow-up.

## Extending

For each new operation:

1. Pick the legacy builder factory (`createVaultBuilders`,
   `createRepayBuilders`, `createSameAssetSwapBuilders`, ...) and call its
   builder with deterministic inputs.
2. Pick the matching SDK planner. Populate `buildSdkAccount({positions})` with
   the sub-account state the planner needs (e.g. `planRepayFromWallet` reads
   `position.asset` and `position.borrowed`).
3. Call `expectPlansEqual(legacyTxs, sdkPlan)` to assert byte equality after
   approval expansion.

The harness deliberately keeps mocks minimal — the legacy `OperationsContext`
returns `maxUint256` from `erc20.allowance` reads (so no approval step is
emitted), no enabled collaterals/controllers from the lens read (so cleanup
emits nothing), and an undefined `registryGetVault` (so Pyth health-check
injection is a no-op). When a new scenario needs extra RPC behavior, extend
`buildLegacyContext.rpcProvider.readContract` in `harness.ts` rather than
mocking at the test level.
