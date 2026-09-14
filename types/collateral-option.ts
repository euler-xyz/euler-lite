import type { VaultEntity } from '@eulerxyz/euler-v2-sdk'

export interface CollateralOption {
  /** Stable internal identity for otherwise identical options. Never rendered. */
  selectionId?: string
  type: string
  amount: number
  price: number
  apy?: number
  symbol?: string
  assetAddress?: string
  vaultAddress?: string
  subAccount?: string
  tags?: string[]
  disabled?: boolean
  showBalance?: boolean
  vault?: VaultEntity
  label?: string
  compatibilityWarning?: {
    title: string
    message: string
  }
}
