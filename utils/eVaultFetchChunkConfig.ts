import { parseChainIds } from './parseChainIds'

export const EVAULT_FETCH_CHUNK_SIZE = 6
export const EVAULT_FETCH_CHUNK_DELAY_MS = 200

export function parseEVaultFetchChunkChainIds(
  env: NodeJS.ProcessEnv = process.env,
  enabledSet?: Set<number>,
): number[] {
  return parseChainIds(env.EVAULT_FETCH_CHUNK_CHAINS, enabledSet)
}

export function shouldChunkEVaultFetch(
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseEVaultFetchChunkChainIds(env, new Set([chainId])).includes(chainId)
}
