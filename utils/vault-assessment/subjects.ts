import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getDebtOracleRouteSteps } from '~/utils/oracle-route-steps'

export type VaultCheckNamespace = 'strategy' | 'collateral'

export interface VaultCheckSubject {
  namespace: VaultCheckNamespace
  address: string
}

const NAMESPACED_KEY = /^(?:scheduled\.)?(strategy|collateral)\.(0x[a-fA-F0-9]{40})\./
const FULL_ADDRESS = /^0x[a-fA-F0-9]{40}$/

/** The vault a check is about, read from the key's namespace alone so a new rule needs no change here. */
export const getVaultCheckSubject = (key: string): VaultCheckSubject | null => {
  const match = NAMESPACED_KEY.exec(key)
  return match ? { namespace: match[1] as VaultCheckNamespace, address: getAddress(match[2]!) } : null
}

export const vaultCheckSubjectKey = (subject: VaultCheckSubject): string =>
  `${subject.namespace}.${subject.address.toLowerCase()}`

export const collectObservedAddresses = (observed: unknown, limit = 200): string[] => {
  const found = new Map<string, string>()
  const visit = (value: unknown, depth: number) => {
    if (found.size >= limit || depth > 6) return
    if (typeof value === 'string') {
      if (FULL_ADDRESS.test(value) && !found.has(value.toLowerCase())) found.set(value.toLowerCase(), value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1))
      return
    }
    if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1))
  }
  visit(observed, 0)
  return [...found.values()]
}

/** Over the sum of allocations, as the Exposure section shows it; `totalAssets` also counts lost assets. */
export const getStrategyDepositShare = (
  earn: { strategies: readonly { address: string, allocatedAssets: bigint }[] },
  strategy: string,
): number | undefined => {
  const entry = earn.strategies.find(item => item.address.toLowerCase() === strategy.toLowerCase())
  if (!entry) return undefined
  const allocated = earn.strategies.reduce((sum, item) => sum + item.allocatedAssets, 0n)
  if (allocated <= 0n) return 0
  return Number((entry.allocatedAssets * 1_000_000n) / allocated) / 1_000_000
}

export const getCollateralBorrowsUsd = (
  openInterest: readonly Record<string, number>[],
  collateral: string,
): number => {
  const target = collateral.toLowerCase()
  return openInterest.reduce((total, byCollateral) => total + Object.entries(byCollateral)
    .reduce((sum, [address, usd]) => address.toLowerCase() === target && Number.isFinite(usd) ? sum + usd : sum, 0), 0)
}

type OracleRouteHolder = Pick<EVault, 'collaterals' | 'debtPricingOracleRoute'>

/** The collateral whose borrow page shows this adapter; every pair page also shows the liability route. */
export const getOraclePairCollateral = (vault: OracleRouteHolder, adapter: string): string | undefined => {
  const target = adapter.toLowerCase()
  const usesAdapter = (steps: readonly { oracle?: string }[] | undefined) =>
    (steps ?? []).some(step => step.oracle?.toLowerCase() === target)
  const collateral = vault.collaterals.find(item => usesAdapter(item.oracleRoute?.steps))
  if (collateral) return collateral.address
  if (!usesAdapter(getDebtOracleRouteSteps(vault as EVault))) return undefined
  return (vault.collaterals.find(item => item.borrowLTV > 0) ?? vault.collaterals[0])?.address
}

export const formatVaultReferenceName = (vault: {
  productName?: string
  sharesName?: string
  assetSymbol?: string
  escrow?: boolean
}): string | undefined => {
  const symbol = vault.assetSymbol?.trim()
  if (vault.escrow) return symbol ? `Escrowed ${symbol}` : 'Escrowed collateral'
  const product = vault.productName?.trim()
  if (product) {
    const carriesSymbol = !!symbol && product.toLowerCase().split(/\s+/).includes(symbol.toLowerCase())
    return symbol && !carriesSymbol ? `${product} ${symbol}` : product
  }
  return vault.sharesName?.trim() || undefined
}
