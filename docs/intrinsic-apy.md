# Intrinsic APY

Intrinsic APY represents yield that is native to the underlying asset itself, independent of the Euler lending market. For example, wstETH earns staking yield from Lido, sDAI earns the DAI Savings Rate, and Pendle PT tokens earn implied yield from the fixed-rate market.

Euler Lite adds this intrinsic yield on top of the vault's lending/borrowing APY so users see the total effective return.

## Architecture

All provider fetching, filtering, and APY extraction happens **server-side**. The client issues one parameter-less request per chain and receives a flat `{ [lowercaseAddress]: { apy, provider, source? } }` map. No giant upstream payloads hit the wire, and the client carries no provider-specific code.

```text
┌──────────────────────────────┐
│    useIntrinsicApy()         │  Client composable
│  - TTL cache (5 min)         │  Single GET /api/intrinsic-apy?chainId=X
│  - address → info lookup     │
│  - chain-switch invalidation │
└──────────────┬───────────────┘
               │  GET /api/intrinsic-apy?chainId=X
               ▼
┌──────────────────────────────┐
│  /api/intrinsic-apy.get.ts   │  Thin HTTP handler
│   rate-limit, chain-id check │
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│  server/utils/intrinsic-apy  │  Orchestrator
│  - filter intrinsicApySources│
│    by chain → group by       │
│    provider → run extractor  │
│  - cache upstream JSON for   │
│    5 min, in-flight dedup    │
│  - merge [address, info] into│
│    a single flat map         │
└──────────────┬───────────────┘
               │  fanout over providers
   ┌───────────┼──────────────┬───────────────┐
   ▼           ▼              ▼               ▼
DefiLlama   Pendle (per-   Securitize     Stablewatch,
yields      market API)   (per-symbol)    Renzo, Midas,
            per-chain                     Yo, Ether.fi,
                                          Puffer, Spark,
                                          Treehouse, Ondo,
                                          Benqi, Avant …
```

## Data flow

1. Client hits `GET /api/intrinsic-apy?chainId=X`.
2. Server filters `intrinsicApySources` to entries where `chainId === X` and groups by provider.
3. Each provider's extractor fetches its upstream(s) (cached per-URL with 5 min TTL and in-flight dedup) and returns `[lowercaseAddress, IntrinsicApyInfo][]`.
4. Extractors are composed via `Promise.allSettled` — one provider failing never kills the response.
5. Results are merged into `Record<lowercaseAddress, IntrinsicApyInfo>` and returned.

### Server entry point

`server/utils/intrinsic-apy.ts` exports `getIntrinsicApyForChain(chainId)`. The HTTP handler is a thin wrapper that does request validation + rate-limiting; all the interesting code is in the util.

### Upstream caching

Every upstream URL is cached under its own key in a shared TTL cache (5 min). Shared upstreams (e.g. `/defillama` global pools list, a pendle market used across chains) are fetched once and reused across every chain request in the TTL window. In-flight dedup collapses concurrent callers onto a single network round-trip per key.

### Warm-cache

`server/plugins/warm-cache.ts` hits `/api/intrinsic-apy?chainId=X` for every enabled chain at boot and re-warms every 4 minutes. After the first warm, every client request per chain is a fast cache hit.

## Client types (`entities/intrinsic-apy.ts`)

```typescript
interface IntrinsicApyInfo {
  readonly apy: number        // percentage (e.g. 3.5 = 3.5%)
  readonly provider: string   // human-readable (e.g. "Lido via DefiLlama", "Pendle")
  readonly source?: string    // URL to verify the APY
}
```

The client never imports provider-specific types. The endpoint's response shape (`Record<string, IntrinsicApyInfo>`) is the entire client contract.

## Source config

`entities/custom.ts` exports `intrinsicApySources: readonly IntrinsicApySourceConfig[]`. Each entry ties a vault address to a provider-specific lookup key (pool ID for DefiLlama, market address for Pendle, symbol for Securitize, etc.). This single config drives both the source list the client reasons about and the extraction the server performs.

To add a new APY source, append an entry to `intrinsicApySources` — no server or client code changes required as long as the provider is already supported.

## Adding a new provider

1. Add the new `provider` variant to `IntrinsicApySourceConfig` in `entities/custom.ts`.
2. Add an upstream URL entry to `UPSTREAM_URLS` in `server/utils/intrinsic-apy.ts`.
3. Implement the extraction function (mirror the existing `extract*` functions). If the provider has a single URL with a scalar APY applied uniformly to every source, add it to `SIMPLE_SPECS` instead — no new function needed.
4. Wire it up in the `extractForProvider` switch.
