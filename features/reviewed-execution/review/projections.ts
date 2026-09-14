import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { ReviewedRequestSet } from '../domain/reviewed-execution'
import { reviewedRequestDigest } from '../materialization/prepared-plan'

export interface ReviewProjection {
  schemaVersion: 1
  requestDigest: Hash
  requests: ReviewedRequestSet['requests']
}

const project = (requestSet: ReviewedRequestSet): Readonly<ReviewProjection> => {
  const projection: ReviewProjection = { schemaVersion: 1, requestDigest: reviewedRequestDigest(requestSet), requests: requestSet.requests }
  return deepFreezeSerializable(projection) as Readonly<ReviewProjection>
}

export const buildCalldataProjection = project
export const buildTenderlyProjection = project

export const projectionDigest = (projection: ReviewProjection): Hash =>
  canonicalDigest('reviewed-execution-projection-v1', toCanonicalValue(projection))
