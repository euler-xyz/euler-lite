import type { Hash } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'

/**
 * Canonical digest of a compiled transaction plan. The preview cache and the
 * batch review parity check both compare plans by this digest, so one plan
 * always yields one digest across compile sites.
 */
export const transactionPlanDigest = (plan: TransactionPlan): Hash =>
  canonicalDigest('preview-plan-v1', toCanonicalValue(plan))
