import { createTtlCache } from './cache'
import { tryChecksum } from './labels-helpers'
import { buildLabelsView, type LabelsView } from './labels-view'
import { logger } from '~/server/utils/logger'
import { isEarnVaultOwnerVerified, isVaultGovernorVerified } from '~/utils/vault/governor-verification'

const CACHE_TTL_MS = 300_000

const cache = createTtlCache<Set<string>>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<Set<string>>>()

function computeVerifiedSet(view: LabelsView): Set<string> {
  const result = new Set<string>()

  // Trust anchor: every address surfaced by the on-chain
  // EscrowedCollateralPerspective is considered known. Matches the client's
  // `vaultCategory === 'escrow'` short-circuit, but applies before the
  // snapshot lookup so escrow vaults missing from the snapshot's collateral
  // subset are still covered.
  for (const addr of view.escrowAddresses) result.add(addr)

  for (const vault of view.snapshot.evkVaults) {
    const addr = tryChecksum(vault.address)
    if (addr && view.productByVault.get(addr)?.forceUnverified === true) continue
    if (isVaultGovernorVerified(vault, view.verificationLabels)) {
      if (addr) result.add(addr)
    }
  }
  for (const vault of view.snapshot.securitizeVaults) {
    const addr = tryChecksum(vault.address)
    if (addr && view.productByVault.get(addr)?.forceUnverified === true) continue
    if (isVaultGovernorVerified(vault, view.verificationLabels)) {
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

/**
 * Force-rebuild path used by the warm-cache plugin. Always rebuilds —
 * bypasses the fresh-cache short-circuit so the warmer can keep the cache
 * continuously fresh on its own schedule rather than waiting for a TTL
 * expiry. Falls back to stale data and re-throws on a hard rebuild failure,
 * matching the read path so a failed warm doesn't poison the cache.
 */
export async function refreshVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const key = String(chainId)
  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      const view = await buildLabelsView(chainId)
      const set = computeVerifiedSet(view)
      cache.set(key, set)
      return set
    }
    catch (err) {
      logger.warn({ ctx: 'verified-vaults', chainId, err }, 'rebuild failed')
      const stale = cache.getStale(key)
      if (stale) return stale
      throw err
    }
    finally {
      inflight.delete(chainId)
    }
  })()

  inflight.set(chainId, task)
  return task
}

export async function getVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const fresh = cache.get(String(chainId))
  if (fresh) return fresh
  return refreshVerifiedAddressSet(chainId)
}
