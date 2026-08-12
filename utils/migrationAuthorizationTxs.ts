import { encodeFunctionData, type Address, type Hex } from 'viem'
import type { MigrationAuthorizationCall, MigrationAuthorizationRequest } from '@eulerxyz/euler-v2-sdk'
import type { DisplayStep } from '~/utils/stepDecoding'
import type { WalletExecutionContext } from '~/utils/walletExecutionContext'

/**
 * Presentation and encoding for the SDK's transaction-form migration
 * authorizations.
 *
 * The protocol knowledge — which contract, which function, which arguments, and
 * what undoes them — lives in the SDK connectors. Request the transaction form
 * with `authorizationKind: 'transaction'` and this module turns the returned
 * calls into something sendable and something displayable.
 */

/** The minimum a caller needs to broadcast one of these transactions. */
export interface PlainTxRequest {
  to: Address
  data: Hex
  value?: bigint
}

/** A restoration transaction bound to the wallet context that sent its grant. */
export interface MigrationAuthorizationRevoke {
  transaction: PlainTxRequest
  walletContext: WalletExecutionContext
}

export interface MigrationAuthorizationTxs {
  /** Grant, to send and mine before the migration plan is built. */
  grants: PlainTxRequest[]
  /** SDK revocations that restore prior state, in reverse grant order. */
  revokes: PlainTxRequest[]
  /** Restoration paired with each grant, in grant order, for incremental cleanup. */
  revokesByGrant: Array<PlainTxRequest | undefined>
}

const encodeCall = (call: MigrationAuthorizationCall): PlainTxRequest => ({
  to: call.to,
  data: encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args as readonly unknown[],
  }),
  ...(call.value === undefined ? {} : { value: call.value }),
})

/** Stable identity of an encoded transaction, for consolidating display rows. */
const plainTxKey = (tx: PlainTxRequest): string =>
  `${tx.to.toLowerCase()}:${(tx.value ?? 0n).toString()}:${tx.data}`

const flattenRequests = (
  request: MigrationAuthorizationRequest | undefined,
): MigrationAuthorizationRequest[] =>
  request
    ? [request, ...flattenRequests(request.postMigrationAuthorization)]
    : []

/**
 * Encode an authorization request into its grant and restoration transactions.
 *
 * Throws on a typed-data request: that form is signed, not sent, and reaching
 * here with one means the request was fetched without
 * `authorizationKind: 'transaction'`.
 */
export const encodeMigrationAuthorizationTxs = (
  request: MigrationAuthorizationRequest,
): MigrationAuthorizationTxs => {
  const grants: PlainTxRequest[] = []
  const revokes: PlainTxRequest[] = []
  const revokesByGrant: Array<PlainTxRequest | undefined> = []

  for (const entry of flattenRequests(request)) {
    if (entry.kind !== 'transaction') {
      throw new Error('Migration authorization was not requested in transaction form')
    }
    grants.push(encodeCall(entry.call))
    const revoke = entry.revocation ? encodeCall(entry.revocation) : undefined
    revokesByGrant.push(revoke)
    if (revoke) revokes.push(revoke)
  }

  // Unwind in reverse so a later grant never depends on an earlier restoration.
  return { grants, revokes: revokes.reverse(), revokesByGrant }
}

const GRANT_LABELS: Record<string, string> = {
  aTokenApproval: 'Approve aToken transfer',
  variableDebtDelegationApproval: 'Approve debt delegation',
  morphoAuthorization: 'Enable Morpho authorization',
  metamorphoApproval: 'Approve Morpho vault shares',
}

const RESTORE_LABELS: Record<string, string> = {
  aTokenApproval: 'Restore previous aToken approval',
  variableDebtDelegationApproval: 'Restore previous debt delegation',
  morphoAuthorization: 'Restore previous Morpho authorization',
  metamorphoApproval: 'Restore previous Morpho vault share approval',
}

/**
 * Review-modal rows for the grant or restoration transactions. `bundled`
 * marks them as riding in the same Safe submission as the migration batch
 * instead of standalone transactions.
 */
export const buildMigrationAuthorizationTxSteps = (
  request: MigrationAuthorizationRequest | undefined,
  phase: 'grant' | 'revoke',
  startIndex = 1,
  options?: { bundled?: boolean },
): DisplayStep[] => {
  const labels = phase === 'grant' ? GRANT_LABELS : RESTORE_LABELS
  const fallback = phase === 'grant' ? 'Approve migration' : 'Restore previous migration authorization'
  const steps: DisplayStep[] = []

  for (const entry of flattenRequests(request)) {
    if (entry.kind !== 'transaction') continue
    if (phase === 'revoke' && !entry.revocation) continue
    // `authorizationType` is a connector-level discriminator that the published
    // request type does not carry.
    const authorizationType = (entry as { authorizationType?: string }).authorizationType
    steps.push({
      index: startIndex + steps.length,
      label: (authorizationType && labels[authorizationType]) || fallback,
      isSeparateTx: !options?.bundled,
      txKey: plainTxKey(encodeCall(phase === 'grant' ? entry.call : entry.revocation!)),
    })
  }

  return phase === 'revoke' ? steps.reverse().map((step, idx) => ({ ...step, index: startIndex + idx })) : steps
}
