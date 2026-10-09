export const parsePublicImagesBaseUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return ''
  }
}

export const v3ChainLogoUrl = (chainId: number, imagesBaseUrl: string | undefined): string =>
  imagesBaseUrl ? `${imagesBaseUrl}/chains/${chainId}` : ''

export const v3OracleProviderLogoUrl = (key: string, imagesBaseUrl: string | undefined): string | undefined =>
  imagesBaseUrl ? `${imagesBaseUrl}/oracle-providers/${encodeURIComponent(key)}` : undefined
