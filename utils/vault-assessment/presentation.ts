import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress } from 'viem'
import type { VaultWarning } from '~/composables/useVaultWarnings'
import { formatExactAmount, shortenAddress } from '~/utils/string-utils'
import { collectObservedAddresses, getVaultCheckSubject, type VaultCheckSubject } from './subjects'
import { FLAGGED_VAULT_TITLE, getFlaggedVaultLine, type VaultVerdictLike } from './flagged'

export type VaultCheckListingImpact = 'affects-listing' | 'does-not-affect-listing'

export interface VaultCheckLine {
  key: string
  text: string
  outcome: 'fail' | 'unknown'
  parts?: Array<{ text: string, address?: string }>
  /** Element id of the adapter's card in the Oracles section, for lines that come from one adapter. */
  anchor?: string
  adapter?: string
  subject?: VaultCheckSubject
  listingImpact?: VaultCheckListingImpact
}

export const ORACLE_ADAPTERS_CHECKS_KEY = 'oracle.adapters-checks'
export const VAULT_CHECKS_DISCLAIMER = 'Vault checks test this vault\'s configuration against fixed rules. They are not a risk rating or a recommendation by Euler.'
const ADAPTER_RECOGNITION_CHECKS = new Set([
  'feed-recognized', 'pyth-feed-recognized', 'chronicle-feed-recognized', 'cross-legs-recognized', 'pendle-pool-recognized', 'custom-adapter-recognized',
])

export interface AdapterCheckFailure {
  address: string
  checksStatus: 'warning' | 'negative'
  findings: Array<{ key: string, description: string, severity?: string }>
}

export const getAdapterCheckFailures = (finding: VaultAssessmentFinding): AdapterCheckFailure[] => {
  if (finding.key !== ORACLE_ADAPTERS_CHECKS_KEY) return []
  const observed = finding.observed as { failing?: unknown } | null | undefined
  if (!observed || !Array.isArray(observed.failing)) return []
  return observed.failing.flatMap((entry): AdapterCheckFailure[] => {
    if (!entry || typeof entry !== 'object') return []
    const { address, checksStatus, findings } = entry as Record<string, unknown>
    if (typeof address !== 'string' || !isAddress(address)) return []
    const checks = Array.isArray(findings)
      ? findings.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const { key, description, severity } = item as Record<string, unknown>
          if (typeof key !== 'string') return []
          return [{ key, description: typeof description === 'string' ? description : key, ...(typeof severity === 'string' ? { severity } : {}) }]
        })
      : []
    return [{ address: getAddress(address), checksStatus: checksStatus === 'negative' ? 'negative' : 'warning', findings: checks }]
  })
}

/** An adapter reaches the vault when it is negative, fails a high-severity check, or fails feed recognition together with another check; a lone medium failure stays in Oracles. */
export const adapterFailureWarnsVault = (failure: AdapterCheckFailure): boolean =>
  failure.checksStatus === 'negative'
  || failure.findings.some(check => check.severity === 'high')
  || (failure.findings.some(check => ADAPTER_RECOGNITION_CHECKS.has(check.key)) && failure.findings.length > 1)

export const getWarningAdapterFailures = (finding: VaultAssessmentFinding): AdapterCheckFailure[] =>
  getAdapterCheckFailures(finding).filter(adapterFailureWarnsVault)

export const isMutedAdapterFinding = (finding: VaultAssessmentFinding): boolean =>
  finding.key === ORACLE_ADAPTERS_CHECKS_KEY && finding.outcome === 'fail' && !finding.exempted
  && getWarningAdapterFailures(finding).length === 0

export const oracleAdapterAnchor = (address: string): string => `oracle-adapter-${address.toLowerCase()}`

export interface UpcomingVaultChange {
  key: string
  text: string
  failing: boolean
}

const isShownRule = (key: string, finding: VaultAssessmentFinding): boolean => {
  if (key === 'hooks.zero-or-trusted') return finding.cause?.code === 'exit-operations-disabled'
  if (key === 'oracle.liability-quote' || /^collateral\.[^.]+\.quote$/.test(key)) return true
  if (key === 'irm.max-apy' || key === 'liquidation.max-discount') return true
  if (/^collateral\.[^.]+\.ltv$/.test(key)) return true
  if (key === 'governance.timelock' || key === 'governance.owner-registered' || key === 'governance.curator-registered') return true
  if (/^strategy\.[^.]+\.(recognized|visible)$/.test(key)) return true
  if (/^collateral\.[^.]+\.visible$/.test(key)) return true
  return false
}

const groupKey = (key: string) => key.replace(/^collateral\.[^.]+\./, 'collateral.*.')
const ADDRESS_IN_TEXT = /0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]{4,}(?:…|\.{3})[a-fA-F0-9]{4,}/g
const ADDRESS_IN_KEY = /0x[a-fA-F0-9]{40}/g

export const getVaultCheckCopyableParts = (text: string, finding: VaultAssessmentFinding): VaultCheckLine['parts'] => {
  const candidates = [...new Map(
    [finding.cause?.subject, ...(finding.key.match(ADDRESS_IN_KEY) ?? []), ...collectObservedAddresses(finding.observed)]
      .filter((value): value is string => typeof value === 'string' && isAddress(value))
      .map(address => [address.toLowerCase(), address] as const),
  ).values()]
  const parts: NonNullable<VaultCheckLine['parts']> = []
  let lastIndex = 0

  for (const match of text.matchAll(ADDRESS_IN_TEXT)) {
    const label = match[0]
    const [prefix, suffix] = label.split(/…|\.{3}/)
    const matching = prefix && suffix
      ? candidates.filter(candidate => candidate.toLowerCase().startsWith(prefix.toLowerCase())
        && candidate.toLowerCase().endsWith(suffix.toLowerCase()))
      : []
    const resolved = isAddress(label) ? label : matching.length === 1 ? matching[0] : undefined
    if (!resolved) continue
    if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index) })
    parts.push({ text: label, address: resolved })
    lastIndex = match.index + label.length
  }

  if (!parts.length) return undefined
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) })
  return parts
}

const isOpenFinding = (finding: VaultAssessmentFinding) =>
  (finding.outcome === 'fail' || (finding.outcome === 'unknown' && finding.required)) && !finding.exempted
  && !isMutedAdapterFinding(finding)

const relevantFinding = isOpenFinding

export const getVaultCheckFindings = (assessment: VaultAssessment): { lines: VaultCheckLine[], moreCount: number, reviewCount: number } => {
  const all = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ].filter(relevantFinding)
  const shown = new Map<string, VaultCheckLine>()
  const counted = new Set<string>()
  for (const finding of all) {
    if (isShownRule(finding.key, finding)) {
      const key = groupKey(finding.key)
      if (!shown.has(key) || (shown.get(key)?.outcome === 'unknown' && finding.outcome === 'fail')) {
        const text = finding.outcome === 'unknown' ? 'Being re-checked' : finding.cause?.summary || finding.description
        const parts = getVaultCheckCopyableParts(text, finding)
        shown.set(key, {
          key,
          text,
          outcome: finding.outcome as 'fail' | 'unknown',
          ...(parts ? { parts } : {}),
        })
      }
    }
    else counted.add(groupKey(finding.key))
  }
  const moreCount = counted.size
  return { lines: [...shown.values()], moreCount, reviewCount: shown.size + moreCount }
}

export interface VaultCheckLineOptions {
  adapterLabel?: (address: string) => string | undefined
}

/** Read from the response's own `required` flag, so no rule key is named here. */
export const getVaultCheckListingImpact = (finding: VaultAssessmentFinding): VaultCheckListingImpact | null => {
  if (finding.exempted || isMutedAdapterFinding(finding)) return null
  if (finding.outcome !== 'fail' && finding.outcome !== 'unknown') return null
  return finding.required ? 'affects-listing' : 'does-not-affect-listing'
}

export const VAULT_CHECK_LISTING_IMPACT_LABELS: Record<VaultCheckListingImpact, string> = {
  'affects-listing': 'Affects listing',
  'does-not-affect-listing': 'Doesn\'t affect listing',
}

const listingImpactOf = (finding: VaultAssessmentFinding): { listingImpact?: VaultCheckListingImpact } => {
  const listingImpact = getVaultCheckListingImpact(finding)
  return listingImpact ? { listingImpact } : {}
}

/** The rule description documents the rule for API readers, so it stands in only for an open check that has no cause. */
export const getVaultCheckMessage = (finding: VaultAssessmentFinding): string | null =>
  finding.cause?.summary
  || ((finding.outcome === 'fail' || finding.outcome === 'unknown') && finding.description ? finding.description : null)

const TITLE_WORDS: Record<string, string> = { apy: 'APY', ltv: 'LTV', evc: 'EVC', evault: 'EVault', irm: 'IRM', id: 'ID' }

const humanizeKeyPart = (part: string): string => part
  .split('-')
  .filter(Boolean)
  .map((word, index) => {
    const lower = word.toLowerCase()
    if (Object.hasOwn(TITLE_WORDS, lower)) return TITLE_WORDS[lower]
    return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower
  })
  .join(' ')

export const getVaultCheckTitle = (key: string): string => {
  const parts = key.split('.').filter(part => part && !/^0x[a-fA-F0-9]{40}$/.test(part))
  return humanizeKeyPart(parts.at(-1) ?? key)
}

const GROUP_TITLES: Record<string, string> = {
  oracle: 'Oracles',
  collateral: 'Collateral',
  strategy: 'Strategies',
  governance: 'Governance',
  hooks: 'Hooks',
  irm: 'Interest rate model',
  liquidation: 'Liquidation',
  market: 'Market',
  deployment: 'Deployment',
  configuration: 'Configuration',
  scheduled: 'Scheduled changes',
  evidence: 'Evidence',
}

export interface VaultCheckGroup {
  key: string
  title: string
  findings: VaultAssessmentFinding[]
}

/** A not-applicable finding without a cause only carries observed data (`evidence.*`, `collateral.<address>.ramp`, …). */
export const groupVaultCheckFindings = (findings: readonly VaultAssessmentFinding[]): VaultCheckGroup[] => {
  const groups = new Map<string, VaultCheckGroup>()
  for (const finding of findings) {
    if (finding.outcome === 'not_applicable' && !finding.cause?.summary) continue
    const prefix = finding.key.split('.')[0] || finding.key
    const group = groups.get(prefix)
    groups.set(prefix, group
      ? { ...group, findings: [...group.findings, finding] }
      : { key: prefix, title: Object.hasOwn(GROUP_TITLES, prefix) ? GROUP_TITLES[prefix]! : humanizeKeyPart(prefix), findings: [finding] })
  }
  const best = (group: VaultCheckGroup) => Math.min(...group.findings.map(getVaultCheckFindingRank))
  return [...groups.values()]
    .map(group => ({ ...group, findings: [...group.findings].sort((a, b) => getVaultCheckFindingRank(a) - getVaultCheckFindingRank(b)) }))
    .sort((a, b) => best(a) - best(b))
}

const adapterFailureLines = (finding: VaultAssessmentFinding, options?: VaultCheckLineOptions): VaultCheckLine[] =>
  getWarningAdapterFailures(finding).map((failure) => {
    const label = options?.adapterLabel?.(failure.address) ?? shortenAddress(failure.address)
    const checks = failure.findings.map(check => check.description.replace(/\.$/, '')).join(' · ')
    return {
      key: `${finding.key}:${failure.address.toLowerCase()}`,
      text: `${label} · ${checks}`,
      outcome: 'fail',
      parts: [{ text: label, address: failure.address }, { text: ` · ${checks}` }],
      anchor: oracleAdapterAnchor(failure.address),
      adapter: failure.address,
      ...listingImpactOf(finding),
    }
  })

/** One line per check the row cell counts as failed or unknown, each collateral, strategy and oracle adapter on its own; no finding is left out, or the count and the lines disagree. */
export const getVaultCheckWarningLines = (assessment: VaultAssessment, options?: VaultCheckLineOptions): VaultCheckLine[] => {
  const lines = new Map<string, VaultCheckLine>()
  for (const finding of [...(assessment.configContext?.findings ?? []), ...(assessment.consistencyContext?.findings ?? [])].filter(isOpenFinding)) {
    if (finding.key === ORACLE_ADAPTERS_CHECKS_KEY && finding.outcome === 'fail') {
      for (const line of adapterFailureLines(finding, options)) lines.set(line.key, line)
      continue
    }
    const key = finding.key
    if (lines.has(key) && !(lines.get(key)?.outcome === 'unknown' && finding.outcome === 'fail')) continue
    const text = finding.outcome === 'unknown' ? finding.cause?.summary || 'Being re-checked' : finding.cause?.summary || finding.description
    const parts = getVaultCheckCopyableParts(text, finding)
    const subject = getVaultCheckSubject(finding.key)
    lines.set(key, {
      key,
      text,
      outcome: finding.outcome as 'fail' | 'unknown',
      ...(parts ? { parts } : {}),
      ...(subject ? { subject } : {}),
      ...listingImpactOf(finding),
    })
  }
  return [...lines.values()]
}

export const getVaultCheckFindingRank = (finding: VaultAssessmentFinding): number => finding.outcome === 'fail'
  ? finding.exempted || isMutedAdapterFinding(finding) ? 2 : 0
  : finding.outcome === 'unknown' ? 1 : finding.outcome === 'pass' ? 3 : 4

/** Full findings are loaded only for an opened vault, as in Toolbox's detail view. */
export const getVaultAssessmentCheckDetails = (assessment: VaultAssessment) => {
  const findings = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ]
  const counts = { passed: 0, failed: 0, unknown: 0, accepted: 0, notApplicable: 0, muted: 0 }
  for (const finding of findings) {
    if (finding.outcome === 'fail' && finding.exempted) counts.accepted++
    else if (isMutedAdapterFinding(finding)) counts.muted++
    else if (finding.outcome === 'pass') counts.passed++
    else if (finding.outcome === 'fail') counts.failed++
    else if (finding.outcome === 'unknown') counts.unknown++
    else counts.notApplicable++
  }
  return { findings: [...findings].sort((a, b) => getVaultCheckFindingRank(a) - getVaultCheckFindingRank(b)), counts }
}

export type VaultChecksCell = { text: string, tone: 'positive' | 'warning' | 'muted' }

/** The checks cell, shaped like the oracle rows: open findings as "X failed · Y unknown", else every passing check with the accepted exceptions counted as passed. */
export const getVaultChecksCell = (assessment: VaultAssessment): VaultChecksCell => {
  if (!assessment.assessed) return { text: 'Not assessed', tone: 'muted' }
  const { counts, findings } = getVaultAssessmentCheckDetails(assessment)
  if (counts.failed || counts.unknown) {
    const blocking = findings.some(finding => finding.outcome === 'unknown' && finding.required && !finding.exempted)
    const text = [counts.failed && `${counts.failed} failed`, counts.unknown && `${counts.unknown} unknown`].filter(Boolean).join(' · ')
    return { text, tone: counts.failed || blocking ? 'warning' : 'muted' }
  }
  const passed = counts.passed + counts.accepted
  return passed ? { text: `${passed} passed`, tone: 'positive' } : { text: 'No findings', tone: 'muted' }
}

export type VaultCheckFindingTone = 'pass' | 'error' | 'warning' | 'muted'

/** Red only for what keeps a vault from being listed: a required check that failed or is still undecided and has no accepted exception. */
export const getVaultCheckFindingTone = (finding: VaultAssessmentFinding): VaultCheckFindingTone => {
  if (finding.outcome === 'pass') return 'pass'
  if (finding.outcome === 'not_applicable') return 'muted'
  return finding.required && !finding.exempted ? 'error' : 'warning'
}

export const hasOnlyAcceptedVaultCheckFindings = (assessment: VaultAssessment): boolean => {
  if (!assessment.assessed || assessment.configStatus !== 'verified' || assessment.configContext?.outcome !== 'pass'
    || (assessment.checksStatus !== 'warning' && assessment.checksStatus !== 'positive')) return false
  const findings = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ]
  return findings.some(finding => (finding.outcome === 'fail' && finding.exempted === true) || isMutedAdapterFinding(finding))
    && !findings.some(isOpenFinding)
}

const formatRelativeCheckedAt = (at: string, now: number): string => {
  const elapsed = Math.max(0, now - new Date(at).getTime())
  if (!Number.isFinite(elapsed)) return 'Checks passed'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'Checks passed · checked just now'
  if (minutes < 60) return `Checks passed · checked ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Checks passed · checked ${hours} hr ago`
  return `Checks passed · checked ${Math.floor(hours / 24)} days ago`
}

export const getVaultChecksStatusLine = (
  assessment: VaultAssessment | undefined,
  status: 'idle' | 'loading' | 'available' | 'unavailable',
  now = Date.now(),
): string => {
  if (status === 'unavailable') return 'Checks unavailable'
  if (status !== 'available') return ''
  if (!assessment || !assessment.assessed) return 'Not assessed yet'
  const findings = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ].filter(relevantFinding)
  const reviewCount = getVaultCheckWarningLines(assessment).length
  if (findings.some(finding => finding.outcome === 'fail') && reviewCount > 0) {
    return `Warning · ${reviewCount} to review`
  }
  if (findings.some(finding => finding.outcome === 'unknown')) return 'Being re-checked'
  if (hasOnlyAcceptedVaultCheckFindings(assessment)) {
    return assessment.configLastCheckedAt ? formatRelativeCheckedAt(assessment.configLastCheckedAt, now) : 'Checks passed'
  }
  if (assessment.checksStatus === 'warning' || assessment.checksStatus === 'negative'
    || assessment.configStatus === 'suspended' || assessment.configStatus === 'revoked') return 'Warning'
  if (assessment.configStatus === 'pending' || assessment.configStatus === 'unverified') return 'Being re-checked'
  if (assessment.checksStatus !== 'positive') return 'Being re-checked'
  return assessment.configLastCheckedAt
    ? formatRelativeCheckedAt(assessment.configLastCheckedAt, now)
    : 'Checks passed'
}

const formatPendingTimelock = (value: string): string => {
  if (!/^\d+$/.test(value)) return value
  const seconds = BigInt(value)
  for (const [unit, duration] of [['day', 86400n], ['hour', 3600n], ['minute', 60n]] as const) {
    if (seconds >= duration && seconds % duration === 0n) {
      const count = seconds / duration
      return `${count} ${unit}${count === 1n ? '' : 's'}`
    }
  }
  return `${seconds} second${seconds === 1n ? '' : 's'}`
}

const formatScheduledPending = (
  finding: VaultAssessmentFinding,
  pending: unknown,
  asset?: { decimals: number, symbol?: string },
): string => {
  if (finding.key === 'scheduled.governance.timelock' && typeof pending === 'string') {
    return `timelock ${formatPendingTimelock(pending)}`
  }
  if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
    const value = pending as Record<string, unknown>
    if (typeof value.cap === 'string' && /^\d+$/.test(value.cap)) {
      return `cap ${asset ? formatExactAmount(BigInt(value.cap), asset.decimals, asset.symbol) : `${value.cap} base units`}`
    }
    for (const key of ['owner', 'strategy', 'collateral']) {
      if (typeof value[key] === 'string') return `${key} ${value[key]}`
    }
    return ''
  }
  return typeof pending === 'string' || typeof pending === 'number' ? String(pending) : ''
}

export const getUpcomingVaultChanges = (
  assessment: VaultAssessment,
  asset?: { decimals: number, symbol?: string },
): UpcomingVaultChange[] => {
  if (assessment.family !== 'earn') return []
  return [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ].filter(finding => finding.key.startsWith('scheduled.') && !finding.exempted)
    .map((finding) => {
      const observed = finding.observed && typeof finding.observed === 'object'
        ? finding.observed as Record<string, unknown>
        : {}
      const validAt = typeof observed.validAt === 'string' ? observed.validAt : null
      const date = validAt && Number.isFinite(Date.parse(validAt))
        ? new Date(validAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
        : null
      const pending = formatScheduledPending(finding, observed.pending, asset)
      const summary = (finding.cause?.summary || finding.description)
        .replace(/^Pending change, acceptable from .*?:\s+/i, '')
      const parts = [date ? `from ${date}` : '', pending, summary]
        .filter(Boolean)
      return {
        key: finding.key,
        text: `${parts.join(' · ')}${finding.outcome === 'fail' ? ' · would not pass the checks' : ''}`,
        failing: finding.outcome === 'fail',
      }
    })
}

export const getUnknownVaultCause = (verdict: VaultVerdictLike | undefined): string => {
  if (verdict?.status === 'hidden') return getFlaggedVaultLine(verdict.reason)
  if (verdict?.status === 'pending_review' && verdict.decidedBy === 'unclaimed') return 'This vault is not in the published vault labels.'
  if (verdict && verdict.status !== 'pending_review') return 'This vault is in the published vault labels but could not be verified.'
  return 'This vault has not been checked yet.'
}

/** One risk explanation at the point of action, shared by forms and batch review. */
export const getUnverifiedActionCopy = (
  flaggedNotice: string | null | undefined,
  vaultNames: readonly string[] = [],
): { title: string, description: string } => {
  if (flaggedNotice) return { title: FLAGGED_VAULT_TITLE, description: flaggedNotice }
  const subject = vaultNames.length ? `This action includes ${vaultNames.join(', ')}. ` : ''
  return {
    title: 'Unverified vault',
    description: `${subject}An unrecognized vault may be used for phishing attempts. Confirm you trust its source before continuing.`,
  }
}

export const getCriticalAssessmentWarning = (assessment?: VaultAssessment): VaultWarning | null => {
  if (!assessment?.assessed) return null
  const finding = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ].find(f => f.outcome === 'fail' && !f.exempted && (
    (f.key === 'hooks.zero-or-trusted' && f.cause?.code === 'exit-operations-disabled')
    || f.key === 'oracle.liability-quote'
    || /^collateral\.[^.]+\.quote$/.test(f.key)
  ))
  return finding
    ? {
        level: 'critical',
        title: 'Vault checks',
        message: finding.cause?.summary || finding.description,
      }
    : null
}
