import { isEVault } from '@eulerxyz/euler-v2-sdk'
import type { VaultWarning } from '~/composables/useVaultWarnings'
import { isVaultBorrowable } from '~/utils/vault/classification'

export type LiquidationBotFilterMode = 'none' | 'blacklist' | 'whitelist'

export type LiquidationCoverage
  = | { enabled: false }
    | {
      enabled: true
      chainId: number
      state: 'answered'
      mode: LiquidationBotFilterMode
      /** Lowercase vault addresses the filter names. */
      vaults: string[]
      fetchedAt: number
    }
    | { enabled: true, chainId: number, state: 'no-bot' }

export type LiquidationCoverageContext = 'lend' | 'borrow'

export const LIQUIDATION_COVERAGE_BADGE_LABEL = 'Not covered by default liquidation bot'

const NOT_COVERED = 'The default liquidation bot does not cover borrows from this vault.'

const MESSAGES: Record<LiquidationCoverageContext, string> = {
  lend: `${NOT_COVERED} Liquidation then depends on other liquidators; if none acts, losses from unhealthy positions can reach lenders.`,
  borrow: `${NOT_COVERED} Other liquidators may still liquidate your position.`,
}

const MODES: ReadonlyMap<unknown, LiquidationBotFilterMode> = new Map([
  ['None', 'none'],
  ['Blacklist', 'blacklist'],
  ['Whitelist', 'whitelist'],
])

const MAX_FILTER_ITEMS = 2_000
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

const itemAddress = (item: unknown): string | null => {
  if (typeof item === 'string') return ADDRESS.test(item) ? item.toLowerCase() : null
  if (!item || typeof item !== 'object') return null
  const { address, reason } = item as { address?: unknown, reason?: unknown }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return null
  return typeof address === 'string' && ADDRESS.test(address) ? address.toLowerCase() : null
}

/** A bot's `/vault-filter` answer, or null for anything that is not one. Reasons are not kept. */
export const parseVaultFilter = (
  payload: unknown,
): { mode: LiquidationBotFilterMode, vaults: string[] } | null => {
  if (!payload || typeof payload !== 'object') return null
  const { mode, items } = payload as { mode?: unknown, items?: unknown }
  const parsedMode = MODES.get(mode)
  if (!parsedMode || !Array.isArray(items) || items.length > MAX_FILTER_ITEMS) return null
  const vaults = items.map(itemAddress)
  if (vaults.some(address => address === null)) return null
  return { mode: parsedMode, vaults: [...new Set(vaults as string[])] }
}

/** Both filters apply to the vault an account borrows from; null when coverage is unknown. */
export const isCoveredByDefaultBot = (
  coverage: LiquidationCoverage | undefined,
  vaultAddress: string,
): boolean | null => {
  if (!coverage?.enabled) return null
  if (coverage.state === 'no-bot') return false
  const listed = coverage.vaults.includes(vaultAddress.toLowerCase())
  if (coverage.mode === 'blacklist') return !listed
  if (coverage.mode === 'whitelist') return listed
  if (coverage.mode === 'none') return true
  return null
}

/** Earn and Securitize vaults carry no borrow side. */
export const hasBorrowSide = (vault: unknown): boolean => isEVault(vault) && isVaultBorrowable(vault)

export const getLiquidationCoverageWarning = (context: LiquidationCoverageContext): VaultWarning => ({
  level: 'high',
  title: LIQUIDATION_COVERAGE_BADGE_LABEL,
  message: MESSAGES[context],
})
