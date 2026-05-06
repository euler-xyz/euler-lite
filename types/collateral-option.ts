import type { VaultEntity } from '@eulerxyz/euler-v2-sdk'

export interface CollateralOption {
  type: string
  amount: number
  price: number
  apy?: number
  symbol?: string
  assetAddress?: string
  vaultAddress?: string
  tags?: string[]
  disabled?: boolean
  vault?: VaultEntity
  label?: string
}
