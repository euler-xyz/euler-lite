import { getAddress, isAddress, type Address } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { PolicyState, ReviewedPolicy, ReviewedRequestSet } from '../domain/reviewed-execution'
import { buildReviewedPolicy, collectPolicyRequirements, type PolicyResultInput } from './engine'
import { hasUnverifiedVaultAcknowledgement } from './acknowledgements'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { operationBlockerEntries } from '~/utils/operationGuardRegistry'

const allowed = (version: string, now: number, expiresAt?: number): PolicyState => ({
  state: 'allowed',
  version,
  observedAt: now,
  ...(expiresAt === undefined ? {} : { expiresAt }),
})

const addressOfSubject = (subject: string): Address | undefined => {
  const value = subject.slice(subject.indexOf(':') + 1)
  return isAddress(value) ? getAddress(value) : undefined
}

/** Resolve handoff policy evidence for the exact reviewed request set. */
export const resolveAppPolicy = async (requestSet: ReviewedRequestSet, now = Date.now()): Promise<Readonly<ReviewedPolicy>> => {
  const expiresAt = now + 5 * 60_000
  const { getVault, isVerifiedVault } = useVaultRegistry()
  const { getTokenByAddress } = useTokenList()
  const labelsVersion = getEulerLabelsVersion()
  const approvalSpenders = new Set(requestSet.effects.flatMap(node => node.effect.kind === 'approval' ? [getAddress(node.effect.spender).toLowerCase()] : []))
  const migrationAuthorities = new Set(requestSet.effects.flatMap(node => node.effect.kind === 'migration-authorization' ? [getAddress(node.effect.target).toLowerCase()] : []))
  const pythFeeds = new Set(requestSet.pythRefreshSlots.flatMap(slot => slot.requiredFeedIds.map(feed => feed.toLowerCase())))
  const tosEffectDigest = canonicalDigest('tos-policy-effects-v1', toCanonicalValue(requestSet.effects.filter(node => node.effect.kind === 'tos-call').map(node => node.effect)))

  const results: PolicyResultInput[] = []
  for (const requirement of collectPolicyRequirements(requestSet)) {
    let version = 'policy'
    if (requirement.subject === 'global') {
      if (requirement.concern === 'tos') {
        if (operationBlockerEntries.value.some(([key]) => key === 'tos')) throw new Error('Terms-of-use policy remains unresolved')
        version = `tos:${tosEffectDigest}`
      }
      else if (requirement.concern === 'unverified-acknowledgement') {
        const unverified = requestSet.effects
          .flatMap(effect => effect.policySubjects)
          .filter(subject => subject.kind === 'vault-or-contract')
          .map(subject => getAddress(subject.value))
          .filter(subject => getVault(subject) && !isVerifiedVault(subject))
        if (unverified.some(subject => !hasUnverifiedVaultAcknowledgement(subject))) throw new Error('Unverified vault acknowledgement does not cover the execution')
        version = `unverified:${unverified.map(value => value.toLowerCase()).sort().join(',')}`
      }
    }
    else if (requirement.subject.startsWith('vault-or-contract:')) {
      const address = addressOfSubject(requirement.subject)
      if (!address) throw new Error('Vault/contract policy subject is malformed')
      const vault = getVault(address)
      if (vault) {
        if (!vault.asset?.address || !vault.type) throw new Error(`Vault metadata is incomplete for ${address}`)
        if (!labelsVersion) throw new Error('Euler labels policy metadata is unavailable')
        version = `vault:${vault.type}:${vault.asset.address}:${labelsVersion}`
      }
      else version = `effect-target:${address}`
    }
    else if (requirement.subject.startsWith('asset:')) {
      const address = addressOfSubject(requirement.subject)
      const token = address ? getTokenByAddress(address) : undefined
      if (!address) throw new Error(`Asset policy subject is malformed: ${requirement.subject}`)
      version = token ? `asset:${token.symbol}:${token.decimals}` : `asset:${address}`
    }
    else if (requirement.subject.startsWith('spender:')) {
      const address = addressOfSubject(requirement.subject)
      if (!address || !approvalSpenders.has(address.toLowerCase())) throw new Error('Approval spender is not bound to a final effect')
      version = `spender:${address}`
    }
    else if (requirement.subject.startsWith('pyth-feed:')) {
      const feed = requirement.subject.slice('pyth-feed:'.length).toLowerCase()
      if (!pythFeeds.has(feed)) throw new Error('Pyth feed is not bound to a refresh slot')
      version = `pyth:${feed}`
    }
    else if (requirement.subject.startsWith('authority:')) {
      const address = addressOfSubject(requirement.subject)
      if (!address || !migrationAuthorities.has(address.toLowerCase())) throw new Error('Migration authorization target is not bound to a final effect')
      version = `authority:${address}`
    }
    else if (requirement.subject.startsWith('effect:')) {
      const effectId = requirement.subject.slice('effect:'.length)
      if (!requestSet.effects.some(effect => effect.effectId === effectId)) throw new Error('Policy result references an unknown effect')
      version = `effect:${effectId}`
    }
    results.push({ ...requirement, result: allowed(version, now, requirement.concern === 'tos' ? undefined : expiresAt) })
  }
  return buildReviewedPolicy({ requestSet, results, now })
}
