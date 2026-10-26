import { withSubgraphQueries, type BuildQueryFn, type SubgraphQuerySources } from '@eulerxyz/euler-v2-sdk'
import { SUBGRAPH_TIMEOUT_MS } from '~/entities/tuning-constants'

export type { SubgraphQuerySource as CheckedSubgraphSource } from '@eulerxyz/euler-v2-sdk'

/** Lite supplies proxy policy; the SDK owns discovery, pagination and source checks. */
export const withCheckedSubgraphQueries = (buildQuery: BuildQueryFn, sources: SubgraphQuerySources): BuildQueryFn =>
  withSubgraphQueries(buildQuery, sources, {
    includeMeta: true,
    fetch: (url, init) => fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS),
    }),
    getResponseIdentity: response => response.headers.get('x-subgraph-source') ?? undefined,
  })
