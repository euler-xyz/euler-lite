import { createTtlCache } from './cache'
import { tryChecksum } from './labels-helpers'
import { buildLabelsView, type LabelsView } from './labels-view'
import { logger } from '~/server/utils/logger'
import { isEarnVaultOwnerVerified, isVaultGovernorVerified } from '~/utils/vault/governor-verification'
import { LABELS_MAX_STALE_MS, isLabelsSnapshotUsable } from '~/utils/labels-freshness'

const CACHE_TTL_MS = 300_000

/** The last successful V3 read is older than the keep-alive window; the public bridge answers 503. */
export class VerificationUnavailableError extends Error {
  constructor() {
    super('Vault verification snapshot is too old')
    this.name = 'VerificationUnavailableError'
  }
}

export interface VerifiedAddressSnapshot {
  addresses: Set<string>
  source: LabelsView['labelsSource']
  sourceFetchedAt?: number
}

const cache = createTtlCache<VerifiedAddressSnapshot>({ ttlMs: CACHE_TTL_MS, maxStaleMs: LABELS_MAX_STALE_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<VerifiedAddressSnapshot>>()

const isUsable = (snapshot: VerifiedAddressSnapshot): boolean => {
  if (snapshot.source !== 'v3' && snapshot.source !== 'v3-metadata') return true
  return isLabelsSnapshotUsable(snapshot.sourceFetchedAt)
}

function computeVerifiedSet(view: LabelsView): Set<string> {
  const result = new Set<string>()

  // Trust anchor: every address surfaced by the on-chain
  // EscrowedCollateralPerspective is considered known. Matches the client's
  // perspective-membership check, but applies before the
  // snapshot lookup so escrow vaults missing from the snapshot's collateral
  // subset are still covered.
  for (const addr of view.escrowAddresses) result.add(addr)

  // V3 publishes the verdict used to build verified membership. Its entity
  // consistency decision supersedes the local governor-to-entity probe.
  if (view.labelsSource === 'v3') {
    for (const addr of view.publishedVerifiedAddresses) result.add(addr)
    return result
  }

  for (const vault of view.snapshot.evkVaults) {
    const addr = tryChecksum(vault.address)
    if (isVaultGovernorVerified({ ...vault, escrowVerified: !!addr && view.escrowAddresses.has(addr) }, view.verificationLabels)) {
      if (addr) result.add(addr)
    }
  }
  for (const vault of view.snapshot.securitizeVaults) {
    const addr = tryChecksum(vault.address)
    if (isVaultGovernorVerified({ ...vault, escrowVerified: false }, view.verificationLabels)) {
      if (addr) result.add(addr)
    }
  }
  for (const earnVault of view.snapshot.earnVaults) {
    if (isEarnVaultOwnerVerified(earnVault, view.verificationLabels)) {
      const addr = tryChecksum(earnVault.address)
      if (addr) result.add(addr)
    }
  }

  return result
}

/** Rebuild the derived set on demand, preserving the source verdict's age. */
async function refreshVerifiedAddressSnapshot(chainId: number): Promise<VerifiedAddressSnapshot> {
  const key = String(chainId)
  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      const view = await buildLabelsView(chainId)
      const snapshot: VerifiedAddressSnapshot = {
        addresses: computeVerifiedSet(view),
        source: view.labelsSource,
        sourceFetchedAt: view.sourceFetchedAt,
      }
      if (!isUsable(snapshot)) throw new VerificationUnavailableError()
      cache.set(key, snapshot)
      return snapshot
    }
    catch (err) {
      logger.warn({ ctx: 'verified-vaults', chainId, err }, 'rebuild failed')
      const stale = cache.getStale(key)
      if (stale && isUsable(stale)) return stale
      if (stale) throw new VerificationUnavailableError()
      throw err
    }
    finally {
      inflight.delete(chainId)
    }
  })()

  inflight.set(chainId, task)
  return task
}

export async function refreshVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  return (await refreshVerifiedAddressSnapshot(chainId)).addresses
}

export async function getVerifiedAddressSnapshot(chainId: number): Promise<VerifiedAddressSnapshot> {
  const fresh = cache.get(String(chainId))
  if (fresh && isUsable(fresh)) return fresh
  return refreshVerifiedAddressSnapshot(chainId)
}

export async function getVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  return (await getVerifiedAddressSnapshot(chainId)).addresses
}

export function getVerifiedAddressCacheControl(snapshot: VerifiedAddressSnapshot, now = Date.now()): string {
  if (snapshot.source !== 'v3' && snapshot.source !== 'v3-metadata') {
    return 'public, max-age=30, stale-while-revalidate=30'
  }
  if (!snapshot.sourceFetchedAt) return 'no-store'
  // Keep the CDN's fresh and stale windows inside the V3 verdict's expiry.
  const remainingSeconds = Math.max(0, Math.floor((snapshot.sourceFetchedAt + LABELS_MAX_STALE_MS - now) / 1000) - 1)
  const maxAge = Math.min(30, remainingSeconds)
  const staleAge = Math.min(30, remainingSeconds - maxAge)
  return `public, max-age=${maxAge}, stale-while-revalidate=${staleAge}`
}
