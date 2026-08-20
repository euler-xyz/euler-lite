import { getAddress, isAddress, zeroAddress, type Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue } from '../domain/canonical'
import type { EvidenceState, PolicyEvidenceBundle } from '../domain/ceremony'
import type { ExecutionTemplate } from '../domain/template'
import type { EffectPolicySubject } from '../domain/effects'

export type PolicySubject = EffectPolicySubject

export interface PolicyRequirement {
  subject: string
  concern: string
}

const subjectKey = (subject: PolicySubject) => `${subject.kind}:${subject.value.toLowerCase()}`

const addAddress = (subjects: Map<string, PolicySubject>, kind: PolicySubject['kind'], value: string) => {
  if (!isAddress(value)) throw new Error(`Policy subject ${kind} has an invalid address`)
  if (getAddress(value) === zeroAddress && kind === 'account') return
  const subject = { kind, value: getAddress(value) }
  subjects.set(subjectKey(subject), subject)
}

export const collectPolicySubjects = (template: ExecutionTemplate): readonly PolicySubject[] => {
  const subjects = new Map<string, PolicySubject>()
  addAddress(subjects, 'account', template.wallet.account)
  template.wallet.subAccounts.forEach(account => addAddress(subjects, 'account', account))

  for (const node of template.effects) {
    for (const subject of node.policySubjects) {
      if (subject.kind === 'pyth-feed') subjects.set(subjectKey(subject), subject)
      else addAddress(subjects, subject.kind, subject.value)
    }
  }
  for (const constraint of template.constraints) {
    if ('token' in constraint) addAddress(subjects, 'asset', constraint.token)
    if ('vault' in constraint) addAddress(subjects, 'vault-or-contract', constraint.vault)
  }
  return [...subjects.values()].sort((left, right) => subjectKey(left).localeCompare(subjectKey(right)))
}

const SUBJECT_CONCERNS: Readonly<Record<PolicySubject['kind'], readonly string[]>> = {
  'account': ['sanctions-screening'],
  'vault-or-contract': ['canonical-live-authority', 'labels-version'],
  'asset': ['asset-metadata'],
  'spender': ['spender-binding'],
  'pyth-feed': ['pyth-freshness'],
  'authority': ['authorization-target'],
}

export const collectPolicyRequirements = (template: ExecutionTemplate): readonly PolicyRequirement[] => {
  const requirements: PolicyRequirement[] = []
  for (const subject of collectPolicySubjects(template)) {
    for (const concern of SUBJECT_CONCERNS[subject.kind]) requirements.push({ subject: subjectKey(subject), concern })
  }
  for (const node of template.effects) {
    if (node.effect.kind === 'approval') requirements.push({ subject: `effect:${node.effectId}`, concern: 'approval-binding' })
    if (node.effect.kind === 'pyth-update') requirements.push({ subject: `effect:${node.effectId}`, concern: 'pyth-preview-bound' })
    if (node.effect.kind === 'migration-authorization') requirements.push({ subject: `effect:${node.effectId}`, concern: 'cleanup-obligation' })
  }
  for (const concern of ['country', 'vpn', 'wallet-screening', 'tos', 'policy-storage', 'unverified-acknowledgement']) {
    requirements.push({ subject: 'global', concern })
  }
  return requirements.sort((left, right) => `${left.subject}:${left.concern}`.localeCompare(`${right.subject}:${right.concern}`))
}

export interface PolicyEvidenceInput {
  subject: string
  concern: string
  result: EvidenceState
}

const assertAllowed = (evidence: PolicyEvidenceInput, now: number) => {
  const result = evidence.result
  if (result.state !== 'allowed') throw new Error(`Policy evidence ${evidence.concern} for ${evidence.subject} is ${result.state}`)
  if (result.observedAt > now) throw new Error(`Policy evidence ${evidence.concern} for ${evidence.subject} is from the future`)
  if (result.expiresAt !== undefined && result.expiresAt <= result.observedAt) throw new Error(`Policy evidence ${evidence.concern} for ${evidence.subject} has an invalid lifetime`)
  if (result.expiresAt !== undefined && result.expiresAt <= now) throw new Error(`Policy evidence ${evidence.concern} for ${evidence.subject} expired`)
}

const EXPIRING_CONCERNS = new Set([
  'country', 'vpn', 'wallet-screening', 'sanctions-screening', 'canonical-live-authority',
  'asset-metadata', 'spender-binding', 'pyth-freshness', 'authorization-target',
  'approval-binding', 'pyth-preview-bound', 'cleanup-obligation', 'policy-storage',
  'unverified-acknowledgement',
])

export const buildPolicyEvidence = ({
  template,
  evidence,
  now,
}: {
  template: ExecutionTemplate
  evidence: readonly PolicyEvidenceInput[]
  now: number
}): Readonly<PolicyEvidenceBundle> => {
  const subjects = collectPolicySubjects(template)
  const required = collectPolicyRequirements(template)
  const requiredKeys = new Set(required.map(item => `${item.subject.toLowerCase()}:${item.concern}`))
  const covered = new Set<string>()
  for (const item of evidence) {
    const key = `${item.subject.toLowerCase()}:${item.concern}`
    if (!requiredKeys.has(key)) throw new Error(`Policy evidence ${item.concern} for ${item.subject} is not required by the final graph`)
    if (covered.has(key)) throw new Error(`Policy evidence ${item.concern} for ${item.subject} is duplicated`)
    assertAllowed(item, now)
    if (EXPIRING_CONCERNS.has(item.concern) && item.result.state === 'allowed' && item.result.expiresAt === undefined) {
      throw new Error(`Policy evidence ${item.concern} for ${item.subject} has no expiry`)
    }
    covered.add(key)
  }
  for (const requirement of required) {
    if (!covered.has(`${requirement.subject.toLowerCase()}:${requirement.concern}`)) {
      throw new Error(`Policy metadata/evidence is missing for ${requirement.concern} on ${requirement.subject}`)
    }
  }

  const digest = canonicalDigest('policy-evidence-v1', toCanonicalValue({ subjects, evidence }))
  const bundle: PolicyEvidenceBundle = { schemaVersion: 1, subjects, evidence, digest }
  return deepFreezeSerializable(bundle) as Readonly<PolicyEvidenceBundle>
}

export const policyEvidenceDigest = (bundle: PolicyEvidenceBundle): Hash => bundle.digest

const policyVersionProjection = (bundle: PolicyEvidenceBundle) => ({
  subjects: bundle.subjects
    .map(subject => ({ kind: subject.kind, value: subject.value.toLowerCase() }))
    .sort((left, right) => `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)),
  evidence: bundle.evidence
    .map((item) => {
      if (item.result.state !== 'allowed') {
        throw new Error(`Current policy evidence ${item.concern} for ${item.subject} is ${item.result.state}`)
      }
      return { subject: item.subject.toLowerCase(), concern: item.concern, version: item.result.version }
    })
    .sort((left, right) => `${left.subject}:${left.concern}`.localeCompare(`${right.subject}:${right.concern}`)),
})

/** Require the current policy lookup to cover the same graph at the same source versions. */
export const assertPolicyEvidenceVersionsMatch = (
  sealed: PolicyEvidenceBundle,
  current: PolicyEvidenceBundle,
) => {
  const sealedDigest = canonicalDigest('policy-version-projection-v1', toCanonicalValue(policyVersionProjection(sealed)))
  const currentDigest = canonicalDigest('policy-version-projection-v1', toCanonicalValue(policyVersionProjection(current)))
  if (sealedDigest !== currentDigest) throw new Error('Policy evidence subjects or source versions changed after review')
}
