import { getChainById } from '~/entities/chainRegistry'

export type ChainTag = { chainId: number, chain: string }

/**
 * Returns `{ chainId, chain }` for spreading into structured log records, so
 * every chain-scoped log line carries both the numeric id and a human-readable
 * name (`chainId: 8453, chain: 'Base'`). Falls back to `chain-<id>` if the id
 * is unknown to `@reown/appkit/networks`.
 */
export const chainTag = (chainId: number): ChainTag => ({
  chainId,
  chain: getChainById(chainId)?.name ?? `chain-${chainId}`,
})
