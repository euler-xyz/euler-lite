import { getAddress } from 'viem'

export interface ExposureBackingAsset {
  address: string
  decimals?: number
  name?: string
  symbol: string
}

export interface ExposureBackingAssetGroup<TItem> {
  asset: ExposureBackingAsset
  items: TItem[]
  vaultCount: number
}

export const normalizeExposureAddress = (address: string): string => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
  }
}

export const groupExposureItemsByBackingAsset = <TItem>(
  items: TItem[],
  getBackingAsset: (item: TItem) => ExposureBackingAsset | undefined,
): ExposureBackingAssetGroup<TItem>[] => {
  const groups = new Map<string, ExposureBackingAssetGroup<TItem>>()

  for (const item of items) {
    const asset = getBackingAsset(item)
    if (!asset?.address) continue

    const key = normalizeExposureAddress(asset.address)
    const existing = groups.get(key)
    if (existing) {
      existing.items.push(item)
      existing.vaultCount += 1
      continue
    }

    groups.set(key, {
      asset: {
        ...asset,
        address: key,
      },
      items: [item],
      vaultCount: 1,
    })
  }

  return [...groups.values()]
}

export const formatExposureVaultCount = (count: number): string =>
  `${count} vault${count === 1 ? '' : 's'}`

export const formatExposureAssetCount = (count: number): string =>
  `${count} backing asset${count === 1 ? '' : 's'}`
