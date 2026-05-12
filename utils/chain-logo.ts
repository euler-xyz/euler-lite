const chainLogoUrls = new Map<number, string>(
  Object.entries(
    import.meta.glob<string>('~/assets/chains/*.webp', { eager: true, query: '?inline', import: 'default' }),
  ).map(([path, url]) => {
    const chainId = Number(path.split('/').pop()?.split('.')[0])
    return Number.isFinite(chainId) ? [chainId, url] as const : null
  }).filter((entry): entry is readonly [number, string] => entry !== null),
)

export const getChainLogoUrl = (chainId: number): string => {
  return chainLogoUrls.get(chainId) ?? ''
}
