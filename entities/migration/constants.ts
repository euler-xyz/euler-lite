export const AAVE_CONNECTOR_ID = 'aave'
export const MORPHO_CONNECTOR_ID = 'morpho'
export const METAMORPHO_CONNECTOR_ID = 'metamorpho'

/**
 * Chains supported end-to-end by Lite's Morpho migration flow: Morpho indexes
 * positions, the SDK configures the Morpho connector, and Euler migration
 * infrastructure is deployed. Discovery skips every other chain so an
 * unsupported indexer request cannot surface as a position-scan failure. Aave
 * discovery self-gates on connector pool presence, so it needs no equivalent
 * list.
 */
export const MORPHO_MIGRATION_SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum
  130, // Unichain
  143, // Monad
  999, // HyperEVM
  8453, // Base
  42161, // Arbitrum
])
