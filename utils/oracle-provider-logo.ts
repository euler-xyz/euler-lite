const bundledLogos = new Map<string, string>(
  Object.entries(
    import.meta.glob<string>('~/assets/oracle-providers/*.webp', { eager: true, query: '?inline', import: 'default' }),
  ).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.')), url]),
)

export const getBundledOracleProviderLogo = (key: string): string | undefined => bundledLogos.get(key)
