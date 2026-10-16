# Adding a Chain

Lite enables a chain from runtime configuration. A code change is needed only when the SDK or a dependency does not support the chain yet, or the chain needs a workaround.

**Before you start:** the chain must be in euler-interfaces `EulerChains.json` (on the branch the deployment reads, `master` by default), normally with status `staging`. Set `RPC_URL_<id>` only after that. A missing or incomplete deployment excludes that chain while other valid chains remain available. A present but invalid row can use its last-good cached addresses only within the existing stale window; a removed row is excluded.

## 1. SDK release

Set the registry `viemName` to the intended export when multiple viem chains share the ID. Both browser and server SDK builds use it. The `@eulerxyz/euler-v2-sdk` version pinned in `package.json` must support the chain: the SDK builds its RPC clients from its own viem chain list and fails on a chain it does not know. If the pinned version lacks the chain, release an SDK version that adds it first. Bumping the pin is a code change for step 2; see [SDK Integration → Installing a new SDK release](./sdk-integration.md#installing-a-new-sdk-release) for the `min-release-age` cooldown.

## 2. Code release, only if anything chain-specific is still needed

Skip this step when none of these apply:

- **SDK pin** from step 1.
- **`@reown/appkit/networks`** must export the chain. Otherwise the server logs the chain ID as unsupported and ignores its `RPC_URL_<id>`. Bump `@reown/appkit` if needed.
- **Chain quirks**, only for chains that need them: SDK `chains` transport options in `server/utils/sdk-server.ts`, batch sizes in `entities/tuning-constants.ts`.

Not needed in code: the chain logo comes from V3 (`/v3/images/chains/<id>`), with an optional bundled fallback in `assets/chains/<id>.webp` (or `.svg`); explorer links come from the registry `explorerUrl`, falling back to the AppKit chain definition and the overrides in `entities/chainRegistry.ts`.

To release: merge the change into `development`, merge `development` into `master`, then push a `v*` tag on `master`. A `v*` tag (without `-rc` or `-beta`) deploys prod and base; a `v*-rc*` or `v*-beta*` tag deploys stage. The dispatcher workflows are in `.github/workflows/build-push-deploy-*.yaml`. The dev environment is deployed by hand from any branch, so you can test an unreleased change there first.

## 3. `RPC_URL_<id>` and `SUBGRAPH_URL_<id>` in Doppler

Add both variables to each Doppler config, in this order: dev → stage → prod **and** base. A `v*` tag deploys prod and base as separate services, each with its own Doppler config, so a chain meant for both needs the variables in both.

- `RPC_URL_<id>`: a valid HTTP(S) RPC URL. Server-side only; the browser reaches it through `/api/internal/rpc/<id>`.
- `SUBGRAPH_URL_<id>`: the chain's Euler subgraph. Server-side only; the browser reaches it through `/api/internal/proxy/subgraph/<id>`.

## 4. ECS redeploy

The container reads Doppler when it starts, so running tasks do not see new variables. Start new tasks for each environment you changed:

- **stage, prod, base**: re-run the environment's latest tag-triggered deploy in the CI/CD repository (it rebuilds the same commit and replaces the tasks), or force a new ECS deployment of the service.
- **dev**: run the dev deploy again with the same branch or commit.

Deploying the image tag that is already live does not start new tasks.

## 5. Test on dev first

On dev, check that the chain appears in the chain selector with its logo, that vault lists and positions load, and that explorer links open the right explorer. Then repeat steps 3 and 4 for stage, then for prod and base.

A `staging` chain is hidden on prod and base. To launch it, change its status to `production` in `EulerChains.json`. Deployments that have `RPC_URL_<id>` show it on the next page load after the server refreshes its manifest copy (every five minutes), without a redeploy.

## How the registry status shows in Lite

A chain appears only when `RPC_URL_<id>` is set and its deployment metadata is admitted. Its `status` in `EulerChains.json` then decides how:

| Status | Lite |
|---|---|
| `production` | Shown. |
| `staging` | Shown only where `DOPPLER_ENVIRONMENT` is not `prd`: dev, stage, and local runs where it is unset. Hidden on prod and base. |
| `deprecated` | Shown in the chain selector's "Deprecated chains" section and skipped by warm-cache, the same as listing it in `DEPRECATED_CHAINS`. |
| `unlisted` | Hidden. |

The retired status `testing` counts as `staging`; any other unknown status hides the chain. When no manifest is cached (upstream down when a task starts), the initial env configuration applies; the browser resolves deployment metadata before constructing SDK providers and keeps only admitted chains. The code is in `utils/chain-status.ts` and `server/plugins/chain-config.ts`.
