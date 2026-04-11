export function parseDeprecatedChains(rawEnv: string | undefined, enabledSet: Set<number>): number[] {
  const raw = rawEnv?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(id => !Number.isNaN(id) && enabledSet.has(id))
    .sort((a, b) => a - b)
}
