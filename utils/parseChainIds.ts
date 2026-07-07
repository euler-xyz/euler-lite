export function parseChainIds(rawEnv: string | undefined, enabledSet?: Set<number>): number[] {
  const raw = rawEnv?.trim()
  if (!raw) return []

  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s))
    .map(s => parseInt(s, 10))
    .filter(id => !enabledSet || enabledSet.has(id))
    .sort((a, b) => a - b)
}
