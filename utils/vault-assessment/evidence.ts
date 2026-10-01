import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress, zeroAddress, type Address } from 'viem'

export type AssessmentSafeEvidence = { threshold: number, owners: Address[] }

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

export const getAssessmentFinding = (assessment: VaultAssessment | undefined, key: string): VaultAssessmentFinding | undefined =>
  assessment?.configContext?.findings.find(finding => finding.key === key)
  ?? assessment?.consistencyContext?.findings.find(finding => finding.key === key)

export const getRouterGovernorEvidence = (assessment: VaultAssessment | undefined): Address | undefined => {
  const observed = record(getAssessmentFinding(assessment, 'evidence.governance')?.observed)
  return typeof observed?.routerGovernor === 'string' && isAddress(observed.routerGovernor)
    ? getAddress(observed.routerGovernor)
    : undefined
}

/** Undefined means no usable evidence, so the caller may use its RPC probe. */
export const getAssessmentSafeEvidence = (
  assessment: VaultAssessment | undefined,
  address: string,
): AssessmentSafeEvidence | null | undefined => {
  const observed = record(getAssessmentFinding(assessment, 'evidence.multisig')?.observed)
  if (!observed || !isAddress(address)) return undefined
  const roles = [observed.vaultGovernor, observed.routerGovernor, observed.owner, observed.curator, observed.guardian]
  const allocators = Array.isArray(observed.allocators) ? observed.allocators : []
  const entry = [...roles, ...allocators]
    .map(record)
    .find(role => typeof role?.address === 'string'
      && isAddress(role.address)
      && role.address.toLowerCase() === address.toLowerCase())
  if (!entry) return undefined
  if (entry.safe === null) return null

  const safe = record(entry.safe)
  if (!safe || !Array.isArray(safe.owners)) return undefined
  const threshold = typeof safe.threshold === 'string' || typeof safe.threshold === 'number'
    ? Number(safe.threshold)
    : NaN
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > safe.owners.length) return undefined
  if (!safe.owners.every(owner => typeof owner === 'string' && isAddress(owner))) return undefined
  const owners = (safe.owners as string[]).map(owner => getAddress(owner))
  const normalizedOwners = owners.map(owner => owner.toLowerCase())
  if (normalizedOwners.some(owner => owner === zeroAddress
    || owner === '0x0000000000000000000000000000000000000001'
    || owner === address.toLowerCase())) return undefined
  if (new Set(normalizedOwners).size !== owners.length) return undefined
  return { threshold, owners }
}

export const getEarnAllocatorAddresses = (assessment: VaultAssessment | undefined): Address[] => {
  const observed = record(getAssessmentFinding(assessment, 'evidence.multisig')?.observed)
  if (!observed) return []
  const probed = Array.isArray(observed.allocators) ? observed.allocators : []
  const unprobed = Array.isArray(observed.unprobedAllocators) ? observed.unprobedAllocators : []
  const addresses = [
    ...probed.map(record).map(role => role?.address),
    ...unprobed,
  ]
  return [...new Set(addresses
    .filter((address): address is string => typeof address === 'string' && isAddress(address))
    .map(address => getAddress(address)))]
}
