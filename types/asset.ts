import type { TokenListItem } from '@eulerxyz/euler-v2-sdk'

export type VaultAsset
  = Pick<TokenListItem, 'address' | 'name' | 'symbol' | 'decimals'>
    & Partial<Pick<TokenListItem, 'logoURI'>>
