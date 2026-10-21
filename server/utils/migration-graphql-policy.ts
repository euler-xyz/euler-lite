import { AAVE_MARKETS_QUERY, MORPHO_MARKETS_QUERY, MORPHO_USER_POSITIONS_QUERY } from '~/utils/migration-graphql'
import type { AllowedGraphqlOperation } from './graphql-proxy-guard'

const hasKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isChainId = (value: unknown) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0x7fffffff
const isAddress = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
const isSingleton = (value: unknown, validate: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length === 1 && validate(value[0])

export const AAVE_ALLOWED_OPERATIONS: readonly AllowedGraphqlOperation[] = [{
  name: 'AaveMigrationMarkets',
  query: AAVE_MARKETS_QUERY,
  validateVariables: variables => hasKeys(variables, ['request'])
    && isRecord(variables.request) && hasKeys(variables.request, ['chainIds'])
    && isSingleton(variables.request.chainIds, isChainId),
}]

export const MORPHO_ALLOWED_OPERATIONS: readonly AllowedGraphqlOperation[] = [{
  name: 'EulerMigrationMorphoMarkets',
  query: MORPHO_MARKETS_QUERY,
  validateVariables: variables => hasKeys(variables, ['chainIds', 'loanAssets', 'collateralAssets'])
    && isSingleton(variables.chainIds, isChainId)
    && isSingleton(variables.loanAssets, isAddress)
    && isSingleton(variables.collateralAssets, isAddress),
}, {
  name: 'LiteMorphoMigrationPositions',
  query: MORPHO_USER_POSITIONS_QUERY,
  validateVariables: variables => hasKeys(variables, ['chainId', 'address'])
    && isChainId(variables.chainId) && isAddress(variables.address),
}]
