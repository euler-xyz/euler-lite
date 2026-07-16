import { encodeFunctionData, type Address, type Hex } from 'viem'
import type { MigrationAuthorizationCall, MigrationAuthorizationRequest } from '@eulerxyz/euler-v2-sdk'
import type { DisplayStep } from '~/utils/stepDecoding'

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

export interface MigrationAuthorizationTxs {
  /** Grant, to send and mine before the migration plan is built. */
  grants: PlainTxRequest[]
  /** Revokes, to send once the migration has settled, in reverse grant order. */
  revokes: PlainTxRequest[]
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

const flattenRequests = (
  request: MigrationAuthorizationRequest | undefined,
): MigrationAuthorizationRequest[] =>
  request
    ? [request, ...flattenRequests(request.postMigrationAuthorization)]
    : []

/**
 * Encode an authorization request into its grant and revoke transactions.
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

  for (const entry of flattenRequests(request)) {
    if (entry.kind !== 'transaction') {
      throw new Error('Migration authorization was not requested in transaction form')
    }
    grants.push(encodeCall(entry.call))
    if (entry.revocation) revokes.push(encodeCall(entry.revocation))
  }

  // Unwind in reverse so a later grant never depends on an earlier revoke.
  return { grants, revokes: revokes.reverse() }
}

const GRANT_LABELS: Record<string, string> = {
  aTokenApproval: 'Approve aToken transfer',
  variableDebtDelegationApproval: 'Approve debt delegation',
  morphoAuthorization: 'Enable Morpho authorization',
  metamorphoApproval: 'Approve Morpho vault shares',
}

const REVOKE_LABELS: Record<string, string> = {
  aTokenApproval: 'Revoke aToken approval',
  variableDebtDelegationApproval: 'Revoke debt delegation',
  morphoAuthorization: 'Disable Morpho authorization',
  metamorphoApproval: 'Revoke Morpho vault share approval',
}

/** Review-modal rows for the standalone grant or revoke transactions. */
export const buildMigrationAuthorizationTxSteps = (
  request: MigrationAuthorizationRequest | undefined,
  phase: 'grant' | 'revoke',
  startIndex = 1,
): DisplayStep[] => {
  const labels = phase === 'grant' ? GRANT_LABELS : REVOKE_LABELS
  const fallback = phase === 'grant' ? 'Approve migration' : 'Revoke migration approval'
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
      isSeparateTx: true,
    })
  }

  return phase === 'revoke' ? steps.reverse().map((step, idx) => ({ ...step, index: startIndex + idx })) : steps
}
