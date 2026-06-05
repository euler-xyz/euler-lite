export function resolveLabelsBaseUrl(): string {
  const explicit = (process.env.NUXT_PUBLIC_CONFIG_LABELS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const repo = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO || 'euler-xyz/euler-labels'
  const branch = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH || 'master'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/${branch}`
}

export function resolveLabelsFileUrl(scope: number | 'all', file: string): string {
  return `${resolveLabelsBaseUrl()}/${scope}/${file}`
}
