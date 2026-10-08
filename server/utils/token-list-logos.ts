export interface TokenLogoEntry {
  chainId: number
  address: string
  logoURI?: string
  hasLogo?: boolean
}

const tokenKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

export const readV3LogoFlags = (items: readonly unknown[]): Map<string, boolean> => {
  const entries = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { chainId, address, hasLogo } = item as { chainId?: unknown, address?: unknown, hasLogo?: unknown }
    if (typeof chainId !== 'number' || typeof address !== 'string' || typeof hasLogo !== 'boolean') return []
    return [[tokenKey(chainId, address), hasLogo] as const]
  })
  return new Map(entries)
}

// A response replaces every flag of the chains it covers, so a token whose
// flag V3 stops sending falls back to its V3 logo.
export const replaceV3LogoFlags = (
  current: ReadonlyMap<string, boolean>,
  items: readonly unknown[],
): Map<string, boolean> => {
  const chainPrefixes = new Set(items.flatMap((item) => {
    const chainId = item && typeof item === 'object' ? (item as { chainId?: unknown }).chainId : undefined
    return typeof chainId === 'number' ? [`${chainId}:`] : []
  }))
  const kept = [...current].filter(([key]) => ![...chainPrefixes].some(prefix => key.startsWith(prefix)))
  return new Map([...kept, ...readV3LogoFlags(items)])
}

// V3 sets logoURI on every token, so only `hasLogo: false` says the image is
// missing; an absent flag (older V3) keeps the V3 logo. Without an image V3's
// logoURI still serves a fallback, so it stays the last choice.
export const preferFallbackLogos = <T extends TokenLogoEntry>(
  primary: readonly T[],
  fallbacks: readonly (readonly TokenLogoEntry[])[],
): (Omit<T, 'hasLogo' | 'logoURI'> & { logoURI?: string })[] => {
  const fallbackLogos = new Map<string, string>()
  for (const list of fallbacks) {
    for (const token of list) {
      const key = tokenKey(token.chainId, token.address)
      if (token.logoURI && !fallbackLogos.has(key)) fallbackLogos.set(key, token.logoURI)
    }
  }

  return primary.map((token) => {
    const { hasLogo, logoURI, ...rest } = token
    const logo = hasLogo === false
      ? fallbackLogos.get(tokenKey(token.chainId, token.address)) ?? logoURI
      : logoURI
    return logo ? { ...rest, logoURI: logo } : rest
  })
}
