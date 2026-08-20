import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { ExecutionTemplate } from '../domain/template'
import { executionTemplateDigest } from '../materialization/prepared-plan'

export interface CeremonyProjection {
  schemaVersion: 1
  templateDigest: Hash
  requests: ExecutionTemplate['requests']
}

const project = (template: ExecutionTemplate): Readonly<CeremonyProjection> => {
  const projection: CeremonyProjection = { schemaVersion: 1, templateDigest: executionTemplateDigest(template), requests: template.requests }
  return deepFreezeSerializable(projection) as Readonly<CeremonyProjection>
}

export const buildCalldataProjection = project
export const buildTenderlyProjection = project

export const projectionDigest = (projection: CeremonyProjection): Hash =>
  canonicalDigest('ceremony-projection-v1', toCanonicalValue(projection))
