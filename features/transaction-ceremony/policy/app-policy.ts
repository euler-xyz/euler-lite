import { getAddress, isAddress, type Address } from 'viem'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { EvidenceState, PolicyEvidenceBundle } from '../domain/ceremony'
import type { ExecutionTemplate } from '../domain/template'
import { buildPolicyEvidence, collectPolicyRequirements, type PolicyEvidenceInput } from './engine'
import { hasUnverifiedVaultAcknowledgement } from './acknowledgements'
import { detectCountry } from '~/services/country'
import { detectVpn } from '~/services/vpn'
import { screenAddress } from '~/services/trm'
import { SANCTIONED_COUNTRIES } from '~/entities/constants'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { operationBlockerEntries } from '~/utils/operationGuardRegistry'

const allowed = (version: string, now: number, expiresAt?: number): EvidenceState => ({
  state: 'allowed',
  version,
  observedAt: now,
  ...(expiresAt === undefined ? {} : { expiresAt }),
})

const addressOfSubject = (subject: string): Address | undefined => {
  const value = subject.slice(subject.indexOf(':') + 1)
  return isAddress(value) ? getAddress(value) : undefined
}

/** Resolve app-owned policy evidence from the final effect graph only. */
export const resolveAppPolicyEvidence = async (template: ExecutionTemplate, now = Date.now()): Promise<Readonly<PolicyEvidenceBundle>> => {
  const expiresAt = now + 5 * 60_000
  const [country, vpn] = await Promise.all([detectCountry(), detectVpn()])
  if (!country || SANCTIONED_COUNTRIES.includes(country)) throw new Error('Country policy evidence is unavailable or blocked')
  if (vpn) throw new Error('VPN policy evidence is blocked')

  const accounts = new Set(
    template.effects.flatMap(effect => effect.policySubjects.filter(subject => subject.kind === 'account').map(subject => getAddress(subject.value))),
  )
  accounts.add(getAddress(template.wallet.account))
  template.wallet.subAccounts.forEach(account => accounts.add(getAddress(account)))
  const screening = await Promise.all([...accounts].map(async account => ({ account, restricted: await screenAddress(account, vpn) })))
  if (screening.some(result => result.restricted)) throw new Error('Wallet or sub-account policy screening is blocked')

  const { getVault, isVerifiedVault } = useVaultRegistry()
  const { getTokenByAddress } = useTokenList()
  const labelsVersion = getEulerLabelsVersion()
  if (!labelsVersion) throw new Error('Euler labels policy metadata is unavailable')
  const effectTargets = new Set(template.effects.map(node => 'target' in node.effect ? getAddress(node.effect.target).toLowerCase() : ''))
  const knownVaultAssets = new Set(template.effects
    .flatMap(effect => effect.policySubjects)
    .filter(subject => subject.kind === 'vault-or-contract')
    .flatMap((subject) => {
      const asset = getVault(subject.value)?.asset?.address
      return asset ? [getAddress(asset).toLowerCase()] : []
    }))
  const approvalSpenders = new Set(template.effects.flatMap(node => node.effect.kind === 'approval' ? [getAddress(node.effect.spender).toLowerCase()] : []))
  const migrationAuthorities = new Set(template.effects.flatMap(node => node.effect.kind === 'migration-authorization' ? [getAddress(node.effect.target).toLowerCase()] : []))
  const pythFeeds = new Set(template.pythRefreshSlots.flatMap(slot => slot.requiredFeedIds.map(feed => feed.toLowerCase())))
  const tosEffectDigest = canonicalDigest('tos-policy-effects-v1', toCanonicalValue(template.effects.filter(node => node.effect.kind === 'tos-call').map(node => node.effect)))

  const dynamicVersion = `policy:${country}:${labelsVersion}`
  const evidence: PolicyEvidenceInput[] = []
  for (const requirement of collectPolicyRequirements(template)) {
    let version = dynamicVersion
    if (requirement.subject === 'global') {
      if (requirement.concern === 'country') version = `country:${country}`
      else if (requirement.concern === 'vpn') version = 'vpn:false'
      else if (requirement.concern === 'wallet-screening') version = `screening:${[...accounts].sort().join(',')}`
      else if (requirement.concern === 'tos') {
        if (operationBlockerEntries.value.some(([key]) => key === 'tos')) throw new Error('Terms-of-use policy remains unresolved')
        version = `tos:${tosEffectDigest}`
      }
      else if (requirement.concern === 'policy-storage' && !globalThis.indexedDB) throw new Error('Durable policy storage is unavailable')
      else if (requirement.concern === 'unverified-acknowledgement') {
        const unverified = template.effects
          .flatMap(effect => effect.policySubjects)
          .filter(subject => subject.kind === 'vault-or-contract')
          .map(subject => getAddress(subject.value))
          .filter(subject => getVault(subject) && !isVerifiedVault(subject))
        if (unverified.some(subject => !hasUnverifiedVaultAcknowledgement(subject))) throw new Error('Unverified vault acknowledgement does not cover the ceremony')
        version = `unverified:${unverified.map(value => value.toLowerCase()).sort().join(',')}`
      }
    }
    else if (requirement.subject.startsWith('account:')) {
      const address = addressOfSubject(requirement.subject)
      if (!address || !accounts.has(address)) throw new Error(`Account policy subject ${requirement.subject} is not screened`)
      version = `screening:${address}`
    }
    else if (requirement.subject.startsWith('vault-or-contract:')) {
      const address = addressOfSubject(requirement.subject)
      if (!address) throw new Error('Vault/contract policy subject is malformed')
      const vault = getVault(address)
      if (!vault && !effectTargets.has(address.toLowerCase())) throw new Error(`Unknown contract authority ${address}`)
      if (vault && (!vault.asset?.address || !vault.type)) throw new Error(`Vault metadata is incomplete for ${address}`)
      version = vault ? `vault:${vault.type}:${vault.asset.address}:${labelsVersion}` : `effect-target:${address}`
    }
    else if (requirement.subject.startsWith('asset:')) {
      const address = addressOfSubject(requirement.subject)
      const token = address ? getTokenByAddress(address) : undefined
      const vaultAsset = address && knownVaultAssets.has(address.toLowerCase())
      if (!address || (!token && !vaultAsset)) throw new Error(`Asset metadata is unavailable for ${requirement.subject}`)
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
      if (!address || !migrationAuthorities.has(address.toLowerCase())) throw new Error('Migration authority is unknown')
      version = `authority:${address}`
    }
    else if (requirement.subject.startsWith('effect:')) {
      const effectId = requirement.subject.slice('effect:'.length)
      if (!template.effects.some(effect => effect.effectId === effectId)) throw new Error('Policy evidence references an unknown effect')
      version = `effect:${effectId}`
    }
    evidence.push({ ...requirement, result: allowed(version, now, requirement.concern === 'tos' ? undefined : expiresAt) })
  }
  return buildPolicyEvidence({ template, evidence, now })
}
