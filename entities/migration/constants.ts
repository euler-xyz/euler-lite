export const AAVE_CONNECTOR_ID = 'aave'
export const MORPHO_CONNECTOR_ID = 'morpho'
export const METAMORPHO_CONNECTOR_ID = 'metamorpho'

/**
 * Chains whose positions Morpho's hosted GraphQL indexer (api.morpho.org) can
 * return. Discovery must skip every other chain: querying an unindexed chain
 * (e.g. BNB Smart Chain, 56) makes the API reject the request with an
 * "unsupported chainId" error, which would otherwise surface as a "could not
 * scan external positions" failure even when the user simply has nothing to
 * migrate. Aave discovery self-gates on connector pool presence, so it needs no
 * equivalent list.
 */
export const MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  8453, // Base
])
