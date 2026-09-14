import { zeroAddress, type Address } from 'viem'

/** Safe's OwnerManager linked-list sentinel — never a legitimate owner. */
const SENTINEL_OWNER = '0x0000000000000000000000000000000000000001'

export type SafeAccountInfo = {
  /** Safe contract version of the singleton the proxy points at, e.g. '1.4.1'. */
  version: string
  /** Number of owner signatures required to execute a transaction. */
  threshold: number
  owners: readonly Address[]
}

/**
 * Canonical Safe singleton (implementation) deployments, lowercased.
 *
 * Safe singletons are deployed deterministically at identical addresses on
 * every chain via the Safe Singleton Factory, so a single append-only list
 * covers all networks. Includes the "eip155" v1.3.0 variants used on chains
 * where the canonical deployment was not possible. zkSync-VM variants are
 * omitted — no supported chain needs them.
 *
 * Source: https://github.com/safe-global/safe-deployments
 *
 * v1.0.0 proxies predate the `masterCopy()` fallback special-case, so v1.0.0
 * Safes fail the probe and simply get no badge.
 */
const SAFE_SINGLETON_VERSIONS: Record<string, string> = {
  '0x34cfac646f301356faa8b21e94227e3583fe3f5f': '1.1.1',
  '0x6851d6fdfafd08c0295c392436245e5bc78b0185': '1.2.0',
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552': '1.3.0',
  '0x69f4d1788e39c87893c980c06edf4b7f686e2938': '1.3.0',
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e': '1.3.0',
  '0xfb1bffc9d739b8d520daf37df666da4c687191ea': '1.3.0',
  '0x41675c099f32341bf84bfc5382af534df5c7461a': '1.4.1',
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': '1.4.1',
  '0xff51a5898e281db6dfc7855790607438df2ca44b': '1.5.0',
  '0xedd160febbd92e350d4d398fb636302fccd67c7e': '1.5.0',
}

export const getSafeSingletonVersion = (
  singleton: string | null | undefined,
): string | undefined =>
  singleton ? SAFE_SINGLETON_VERSIONS[singleton.toLowerCase()] : undefined

/**
 * Validate raw probe results into a SafeAccountInfo, or null when the address
 * is not a recognizable Safe. Threshold/owner invariants mirror what the Safe
 * contracts themselves enforce (OwnerManager forbids zero/sentinel/duplicate
 * owners and self-ownership, GS203); anything violating them is a lookalike.
 *
 * This is a display heuristic: a purpose-built contract can still mimic all
 * probed functions. Never use the result for authorization decisions.
 */
export const resolveSafeAccountInfo = (
  account: string,
  singleton: string | null | undefined,
  threshold: bigint | null | undefined,
  owners: readonly Address[] | null | undefined,
): SafeAccountInfo | null => {
  const version = getSafeSingletonVersion(singleton)
  if (!version) return null
  if (threshold == null || owners == null) return null

  const thresholdCount = Number(threshold)
  if (!Number.isSafeInteger(thresholdCount) || thresholdCount < 1) return null
  if (owners.length < thresholdCount) return null

  const normalizedAccount = account.toLowerCase()
  const normalizedOwners = owners.map(owner => owner.toLowerCase())
  if (normalizedOwners.some(owner =>
    owner === zeroAddress || owner === SENTINEL_OWNER || owner === normalizedAccount,
  )) return null
  if (new Set(normalizedOwners).size !== normalizedOwners.length) return null

  return {
    version,
    threshold: thresholdCount,
    owners,
  }
}
