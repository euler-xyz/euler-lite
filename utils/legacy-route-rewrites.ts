export type LegacyPathRewrite = {
  path: string
  dropQueryKeys?: readonly string[]
}

type LegacyPathRewriteRule = {
  from: RegExp
  to: string
  dropQueryKeys?: readonly string[]
}

// Legacy path rewrites from the pre-lite app. Preserves any trailing segments
// (e.g. vault/collateral addresses) after the renamed prefix.
const LEGACY_PATH_REWRITES: readonly LegacyPathRewriteRule[] = [
  { from: /^\/vault(\/.*)?$/, to: '/lend' },
  { from: /^\/positions(\/.*)?$/, to: '/borrow' },
  { from: /^\/account(\/.*)?$/, to: '/position' },
  { from: /^\/market(\/.*)?$/, to: '/explore', dropQueryKeys: ['tab'] },
]

export const rewriteLegacyPath = (path: string): LegacyPathRewrite | null => {
  for (const { from, to, dropQueryKeys } of LEGACY_PATH_REWRITES) {
    const match = path.match(from)
    if (match) return { path: to + (match[1] ?? ''), dropQueryKeys }
  }
  return null
}

export const omitQueryKeys = <T extends Record<string, unknown>>(
  query: T,
  keys: readonly string[],
): Partial<T> => {
  if (!keys.length) return { ...query }

  const keysToOmit = new Set(keys)
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => !keysToOmit.has(key)),
  ) as Partial<T>
}
