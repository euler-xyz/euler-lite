/**
 * Shared resolution for the euler-interfaces manifest sources consumed by
 * /api/internal/euler-chains and /api/internal/abis/[contract]. Both serve
 * low-churn, boot-critical data extracted from the same repo, so they share
 * one branch-resolution rule and one staleness policy.
 */

export const DEFAULT_EULER_INTERFACES_BRANCH = 'master'

/**
 * How long past TTL the manifest caches keep serving stale data. These are
 * append-only address/ABI documents that change a few times a month; during
 * an upstream outage a days-old copy is strictly better than an unusable
 * app, so they opt out of the default 30-minute staleness ceiling.
 */
export const MANIFEST_MAX_STALE_MS = 7 * 24 * 60 * 60_000

export function resolveEulerInterfacesBranch(): string {
  return (
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH
    || process.env.NUXT_PUBLIC_EULER_INTERFACES_BRANCH
    || process.env.NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH
    || ''
  ).trim() || DEFAULT_EULER_INTERFACES_BRANCH
}

export function eulerInterfacesRawUrl(path: string): string {
  return `https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/${resolveEulerInterfacesBranch()}/${path}`
}
