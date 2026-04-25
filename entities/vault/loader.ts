import { getAddress } from 'viem'
import type { Vault, EarnVault, SecuritizeVault } from './types'
import { type FetchVaultContext, fetchVaults, fetchEarnVaults, fetchSecuritizeVault } from './fetcher'
import { fetchEscrowVault } from './escrow-fetcher'
import { logger } from '~/utils/logger'
import { chainTag } from '~/utils/chain-tag'
import { summarizeViemError } from '~/utils/viem-errors'

/**
 * A full snapshot of the public vault set for one chain. Everything here is
 * wallet-independent — only depends on chainId × vault addresses. Per-user
 * data (balances, debts, collateral flags) is NOT included; the client
 * fetches it separately after wallet connect.
 *
 * Note: escrow categorization used to live here (`escrowAddresses: string[]`)
 * but has moved to `/api/vault-categories`. The snapshot no longer carries
 * that field; clients get the escrow set from the categorization endpoint.
 */
export interface ChainVaultsSnapshot {
  chainId: number
  fetchedAt: number
  /** EVK-family vaults (non-escrow). */
  evkVaults: Vault[]
  earnVaults: EarnVault[]
  securitizeVaults: SecuritizeVault[]
  /** Info for the subset of escrow vaults referenced as collateral / strategy by evkVaults or earnVaults. */
  escrowVaults: Vault[]
}

export interface LoadSnapshotInput {
  chainId: number
  ctx: FetchVaultContext
  /**
   * Verified vault addresses to include in the snapshot, pre-split into EVK
   * and Securitize based on the chain's vault categorization. The caller
   * performs this split using /api/vault-categories and intersects with the
   * labels-derived verified set.
   */
  evkVaultAddresses: string[]
  securitizeVaultAddresses: string[]
  /**
   * Lowercase escrow addresses for the chain (from the EscrowedCollateralPerspective).
   * Used to derive the subset of escrow vaults referenced by EVK collateralLTVs
   * or Earn strategies so we fetch info for them in Phase 3.
   */
  escrowAddresses: string[]
  /** Optional UI-only filters (honoured by the client path, bypassed by server for completeness). */
  nonExplorableVault?: (addr: string) => boolean
  nonExplorableEarn?: (addr: string) => boolean
}

/**
 * Runs the same 3-phase load the client uses in useVaults.loadVaults():
 *   1. caller has already split verified addresses into EVK vs Securitize
 *   2. fetch EVK + Earn + Securitize in parallel
 *   3. fetch info for the escrow subset referenced by (1)
 *
 * Generators are collected into arrays so the caller gets one snapshot.
 * Cancellation is honoured via ctx.isAborted if the caller supplies one
 * (client-side); server callers pass no isAborted and run the full fetch.
 */
export const loadChainSnapshot = async (input: LoadSnapshotInput): Promise<ChainVaultsSnapshot> => {
  const { chainId, ctx, escrowAddresses } = input

  const explorableEvk = input.evkVaultAddresses.filter(
    addr => !input.nonExplorableVault?.(addr),
  )
  const explorableSecuritize = input.securitizeVaultAddresses.filter(
    addr => !input.nonExplorableVault?.(addr),
  )
  const explorableEarn = ctx.earnVaultAddresses.filter(
    addr => !input.nonExplorableEarn?.(addr),
  )

  // Phase 2: three arms in parallel. Each is isolated so one RPC hiccup
  // doesn't kill the whole snapshot — a partial snapshot serves the client
  // better than none.
  const [evkSettled, earnSettled, securitizeSettled] = await Promise.all([
    collectVaults(fetchVaults(ctx, explorableEvk)).then(
      v => ({ ok: true as const, value: v }),
      err => ({ ok: false as const, err }),
    ),
    collectEarnVaults(fetchEarnVaults(ctx, explorableEarn)).then(
      v => ({ ok: true as const, value: v }),
      err => ({ ok: false as const, err }),
    ),
    Promise.allSettled(explorableSecuritize.map(a => fetchSecuritizeVault(a, ctx))),
  ])

  const tag = chainTag(chainId)
  const evkVaults: Vault[] = evkSettled.ok ? evkSettled.value : []
  if (!evkSettled.ok) {
    logger.warn({ ctx: 'loader/evk', ...tag, err: evkSettled.err }, 'EVK vault fetch failed')
  }
  const earnVaults: EarnVault[] = earnSettled.ok ? earnSettled.value : []
  if (!earnSettled.ok) {
    logger.warn({ ctx: 'loader/earn', ...tag, err: earnSettled.err }, 'earn vault fetch failed')
  }

  // Per-securitize-vault errors share the same dedup logic as the earn loop in
  // fetcher.ts: a single transport failure against the RPC produces N "failed"
  // log lines otherwise. We let the first transport error log normally and drop
  // the rest in this batch (genuine on-chain reverts still log because they
  // aren't classified as transport).
  const securitizeVaults: SecuritizeVault[] = []
  let securitizeTransportLogged = false
  securitizeSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      securitizeVaults.push(r.value)
      return
    }
    const summary = summarizeViemError(r.reason)
    if (summary.isTransport && securitizeTransportLogged) return
    if (summary.isTransport) securitizeTransportLogged = true
    logger.warn(
      { ctx: 'loader/securitize', ...tag, vault: explorableSecuritize[i], err: r.reason },
      `securitize vault fetch failed: ${explorableSecuritize[i]}`,
    )
  })

  // Phase 3: derive the escrow subset referenced by EVK collateral LTVs and
  // Earn strategies, and fetch their full info.
  const escrowSet = new Set(escrowAddresses.map(a => a.toLowerCase()))
  const needed = new Set<string>()
  for (const vault of evkVaults) {
    for (const ltv of vault.collateralLTVs) {
      if (ltv.borrowLTV > 0n && escrowSet.has(ltv.collateral.toLowerCase())) {
        needed.add(getAddress(ltv.collateral))
      }
    }
  }
  for (const earn of earnVaults) {
    for (const strategy of earn.strategies) {
      if (escrowSet.has(strategy.strategy.toLowerCase())) {
        needed.add(getAddress(strategy.strategy))
      }
    }
  }

  const escrowSettled = await Promise.allSettled(
    [...needed].map(a => fetchEscrowVault(a, ctx)),
  )
  const escrowVaults: Vault[] = []
  let escrowTransportLogged = false
  const neededAddresses = [...needed]
  escrowSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      escrowVaults.push(r.value)
      return
    }
    const summary = summarizeViemError(r.reason)
    if (summary.isTransport && escrowTransportLogged) return
    if (summary.isTransport) escrowTransportLogged = true
    logger.warn(
      { ctx: 'loader/escrow', ...tag, vault: neededAddresses[i], err: r.reason },
      `escrow vault fetch failed: ${neededAddresses[i]}`,
    )
  })

  return {
    chainId,
    fetchedAt: Date.now(),
    evkVaults,
    earnVaults,
    securitizeVaults,
    escrowVaults,
  }
}

const collectVaults = async (
  gen: AsyncGenerator<{ vaults: Vault[], isFinished: boolean }>,
): Promise<Vault[]> => {
  const out: Vault[] = []
  for await (const batch of gen) {
    out.push(...batch.vaults)
    if (batch.isFinished) break
  }
  return out
}

const collectEarnVaults = async (
  gen: AsyncGenerator<{ vaults: EarnVault[], isFinished: boolean }>,
): Promise<EarnVault[]> => {
  const out: EarnVault[] = []
  for await (const batch of gen) {
    out.push(...batch.vaults)
    if (batch.isFinished) break
  }
  return out
}
