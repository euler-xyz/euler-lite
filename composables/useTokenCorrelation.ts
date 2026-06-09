import { getAddress } from 'viem'
import {
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type PortfolioBorrowPosition,
  type SecuritizeCollateralVault,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import type { TokenListEntry } from '~/composables/useTokenList'

type CorrelationCategory = 'stable' | 'eth' | 'btc' | string

const CATEGORY_LABELS: Record<string, string> = {
  stable: 'Stable',
  eth: 'ETH',
  btc: 'BTC',
}

const CATEGORY_ALIASES: Record<string, CorrelationCategory> = {
  stablecoin: 'stable',
  stables: 'stable',
  usd: 'stable',
  eth_lst: 'eth',
  eth_lrt: 'eth',
  ethlst: 'eth',
  ethlrt: 'eth',
  weth: 'eth',
  btc_lst: 'btc',
  btclst: 'btc',
  wbtc: 'btc',
}

const STABLE_SYMBOLS = new Set([
  'USDC',
  'USDT',
  'DAI',
  'USDS',
  'SUSDS',
  'USDE',
  'SUSDE',
  'USD0',
  'USD0++',
  'CRVUSD',
  'LUSD',
  'FRAX',
  'GHO',
  'PYUSD',
  'TUSD',
  'RLUSD',
  'USR',
  'USDL',
])

const normalizeCategory = (value: string): CorrelationCategory | undefined => {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized || normalized === 'other') return undefined
  return CATEGORY_ALIASES[normalized] ?? normalized
}

const firstCategory = (entry: TokenListEntry | undefined): CorrelationCategory | undefined => {
  if (!entry) return undefined
  const values = [
    entry.category,
    ...(entry.categories ?? []),
    ...(entry.tags ?? []),
  ].filter((value): value is string => typeof value === 'string')

  for (const value of values) {
    const category = normalizeCategory(value)
    if (category) return category
  }
}

const fallbackCategoryFromSymbol = (symbol: string): CorrelationCategory | undefined => {
  const normalized = symbol.trim().toUpperCase()
  if (!normalized) return undefined
  if (STABLE_SYMBOLS.has(normalized) || normalized.includes('USD')) return 'stable'
  if (normalized === 'ETH' || normalized === 'WETH' || normalized.endsWith('ETH')) return 'eth'
  if (normalized === 'BTC' || normalized === 'WBTC' || normalized.includes('BTC')) return 'btc'
}

const normalizeAddressSafe = (address: string): string => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
  }
}

export const useTokenCorrelation = () => {
  const { getTokenByAddress } = useTokenList()

  const getAssetCorrelationCategory = (
    address: string | undefined,
    symbol?: string,
  ): CorrelationCategory | undefined => {
    if (!address) return symbol ? fallbackCategoryFromSymbol(symbol) : undefined
    const token = getTokenByAddress(address)
    return firstCategory(token) ?? fallbackCategoryFromSymbol(token?.symbol ?? symbol ?? '')
  }

  const getAssetCorrelationLabel = (
    address: string | undefined,
    symbol?: string,
  ): string | undefined => {
    const category = getAssetCorrelationCategory(address, symbol)
    if (!category) return undefined
    return CATEGORY_LABELS[category] ?? category
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  const areAssetsCorrelated = (
    collateral: { address?: string, symbol?: string },
    liability: { address?: string, symbol?: string },
  ): boolean => {
    if (collateral.address && liability.address && normalizeAddressSafe(collateral.address) === normalizeAddressSafe(liability.address)) {
      return true
    }
    const collateralCategory = getAssetCorrelationCategory(collateral.address, collateral.symbol)
    const liabilityCategory = getAssetCorrelationCategory(liability.address, liability.symbol)
    return !!collateralCategory && collateralCategory === liabilityCategory
  }

  const isBorrowPositionCorrelated = (position: PortfolioBorrowPosition<VaultEntity>): boolean => {
    const borrowVault = position.borrowVault as EVault | undefined
    if (!borrowVault?.asset) return false

    const collateralVaults = position.collaterals.flatMap((collateralPosition) => {
      const vault = collateralPosition.vault
      return vault && (isEVault(vault) || isSecuritizeCollateralVault(vault))
        ? [vault]
        : []
    })

    const fallbackCollateral = position.collateralVault as EVault | SecuritizeCollateralVault | undefined
    const collaterals = collateralVaults.length
      ? collateralVaults
      : fallbackCollateral
        ? [fallbackCollateral]
        : []

    return collaterals.length > 0
      && collaterals.every(collateralVault => areAssetsCorrelated(collateralVault.asset, borrowVault.asset))
  }

  return {
    areAssetsCorrelated,
    getAssetCorrelationCategory,
    getAssetCorrelationLabel,
    isBorrowPositionCorrelated,
  }
}
