import { getAddress } from 'viem'
import type { Vault, EarnVault, SecuritizeVault } from './types'
import { type FetchVaultContext, fetchVaults, fetchEarnVaults, fetchSecuritizeVault } from './fetcher'
import { fetchEscrowAddresses, fetchEscrowVault } from './escrow-fetcher'
import { logWarn } from '~/utils/errorHandling'

/**
 * A full snapshot of the public vault set for one chain. Everything here is
 * wallet-independent — only depends on chainId × vault addresses. Per-user
 * data (balances, debts, collateral flags) is NOT included; the client
 * fetches it separately after wallet connect.
 */
export interface ChainVaultsSnapshot {
  chainId: number
  fetchedAt: number
  /** EVK-family vaults (non-escrow). */
  evkVaults: Vault[]
  earnVaults: EarnVault[]
  securitizeVaults: SecuritizeVault[]
  /** All escrow vault addresses known to the chain (from escrowedCollateralPerspective). */
  escrowAddresses: string[]
  /** Info for the subset of escrow vaults referenced as collateral / strategy by evkVaults or earnVaults. */
  escrowVaults: Vault[]
}

export interface LoadSnapshotInput {
  chainId: number
  ctx: FetchVaultContext
  peripheryAddresses: {
    escrowedCollateralPerspective?: string
    securitizeFactory?: string
  }
  /**
   * Lowercase vault address → factory address, for splitting verified vault
   * addresses into EVK vs Securitize. Client: from /api/vault-factories proxy.
   * Server: from direct subgraph query.
   */
  factories: Map<string, string>
  /** Optional UI-only filters (honoured by the client path, bypassed by server for completeness). */
  nonExplorableVault?: (addr: string) => boolean
  nonExplorableEarn?: (addr: string) => boolean
}

/**
 * Runs the same 3-phase load the client uses in useVaults.loadVaults():
 *   1. split EVK vs Securitize by factory
 *   2. fetch EVK + Earn + Securitize + escrow-address-list in parallel
 *   3. fetch info for the escrow subset referenced by (1)
 *
 * Generators are collected into arrays so the caller gets one snapshot.
 * Cancellation is honoured via ctx.isAborted if the caller supplies one
 * (client-side); server callers pass no isAborted and run the full fetch.
 */
export const loadChainSnapshot = async (input: LoadSnapshotInput): Promise<ChainVaultsSnapshot> => {
  const { chainId, ctx, peripheryAddresses, factories } = input

  const explorableVault = ctx.verifiedVaultAddresses.filter(
    addr => !input.nonExplorableVault?.(addr),
  )
  const explorableEarn = ctx.earnVaultAddresses.filter(
    addr => !input.nonExplorableEarn?.(addr),
  )

  const securitizeFactory = peripheryAddresses.securitizeFactory?.toLowerCase()
  const evkAddresses: string[] = []
  const securitizeAddresses: string[] = []
  for (const addr of explorableVault) {
    const factory = factories.get(addr.toLowerCase())
    if (securitizeFactory && factory?.toLowerCase() === securitizeFactory) {
      securitizeAddresses.push(addr)
    }
    else {
      evkAddresses.push(addr)
    }
  }

  const escrowAddressesPromise = peripheryAddresses.escrowedCollateralPerspective
    ? fetchEscrowAddresses(ctx.rpcUrl, peripheryAddresses.escrowedCollateralPerspective, ctx.chainId)
    : Promise.resolve<string[]>([])

  // Phase 2: all four in parallel. Each arm is `allSettled` so one RPC
  // hiccup on e.g. the escrow-addresses read doesn't kill the whole
  // snapshot — a partial snapshot serves the client better than none.
  const [evkSettled, earnSettled, securitizeSettled, escrowAddressesSettled] = await Promise.all([
    collectVaults(fetchVaults(ctx, evkAddresses)).then(
      v => ({ ok: true as const, value: v }),
      err => ({ ok: false as const, err }),
    ),
    collectEarnVaults(fetchEarnVaults(ctx, explorableEarn)).then(
      v => ({ ok: true as const, value: v }),
      err => ({ ok: false as const, err }),
    ),
    Promise.allSettled(securitizeAddresses.map(a => fetchSecuritizeVault(a, ctx))),
    escrowAddressesPromise.then(
      v => ({ ok: true as const, value: v }),
      err => ({ ok: false as const, err }),
    ),
  ])

  const evkVaults: Vault[] = evkSettled.ok ? evkSettled.value : []
  if (!evkSettled.ok) logWarn('loader/evk', evkSettled.err)
  const earnVaults: EarnVault[] = earnSettled.ok ? earnSettled.value : []
  if (!earnSettled.ok) logWarn('loader/earn', earnSettled.err)
  const escrowAddresses: string[] = escrowAddressesSettled.ok ? escrowAddressesSettled.value : []
  if (!escrowAddressesSettled.ok) logWarn('loader/escrowAddresses', escrowAddressesSettled.err)

  const securitizeVaults: SecuritizeVault[] = []
  securitizeSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') securitizeVaults.push(r.value)
    else logWarn(`loader/securitize/${securitizeAddresses[i]}`, r.reason)
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
  escrowSettled.forEach((r, i) => {
    if (r.status === 'fulfilled') escrowVaults.push(r.value)
    else logWarn(`loader/escrow/${[...needed][i]}`, r.reason)
  })

  return {
    chainId,
    fetchedAt: Date.now(),
    evkVaults,
    earnVaults,
    securitizeVaults,
    escrowAddresses,
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
