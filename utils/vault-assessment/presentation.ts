import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import type { VaultWarning } from '~/composables/useVaultWarnings'

export interface VaultCheckLine {
  key: string
  text: string
  outcome: 'fail' | 'unknown'
}

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

const isCountedRule = (key: string): boolean =>
  /^(deployment|configuration)\./.test(key)
  || /^market\..+-present$/.test(key)
  || ['oracle.recognized-router', 'oracle.no-fallback', 'governance.router', 'irm.rate-computation', 'liquidation.cool-off'].includes(key)
  || /^collateral\.[^.]+\.recognized$/.test(key)

const groupKey = (key: string) => key.replace(/^collateral\.[^.]+\./, 'collateral.*.')
const relevantFinding = (finding: VaultAssessmentFinding) =>
  (finding.outcome === 'fail' || (finding.outcome === 'unknown' && finding.required))
  && !finding.exempted
  && !finding.key.startsWith('evidence.')
  && !finding.key.startsWith('scheduled.')
  && finding.key !== 'oracle.adapters-recognized'

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
      if (!shown.has(key)) {
        shown.set(key, {
          key,
          text: finding.outcome === 'unknown' ? 'Being re-checked' : finding.cause?.summary || finding.description,
          outcome: finding.outcome as 'fail' | 'unknown',
        })
      }
    }
    else if (isCountedRule(finding.key)) counted.add(groupKey(finding.key))
  }
  const moreCount = counted.size
  return { lines: [...shown.values()], moreCount, reviewCount: shown.size + moreCount }
}

const formatRelativeCheckedAt = (at: string, now: number): string => {
  const elapsed = Math.max(0, now - new Date(at).getTime())
  if (!Number.isFinite(elapsed)) return 'Verified'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'Verified · checked just now'
  if (minutes < 60) return `Verified · checked ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Verified · checked ${hours} hr ago`
  return `Verified · checked ${Math.floor(hours / 24)} days ago`
}

export const getVaultChecksStatusLine = (
  assessment: VaultAssessment | undefined,
  status: 'idle' | 'loading' | 'available' | 'unavailable',
  now = Date.now(),
): string => {
  if (status === 'unavailable') return 'Checks unavailable'
  if (status !== 'available') return ''
  if (!assessment || !assessment.assessed) return 'Not assessed yet'
  const { reviewCount } = getVaultCheckFindings(assessment)
  const findings = [
    ...(assessment.configContext?.findings ?? []),
    ...(assessment.consistencyContext?.findings ?? []),
  ].filter(relevantFinding)
  if (findings.some(finding => finding.outcome === 'fail') && reviewCount > 0) {
    return `Flagged · ${reviewCount} to review`
  }
  if (findings.some(finding => finding.outcome === 'unknown')) return 'Being re-checked'
  if (assessment.checksStatus === 'warning' || assessment.checksStatus === 'negative'
    || assessment.configStatus === 'suspended' || assessment.configStatus === 'revoked') return 'Flagged'
  if (assessment.configStatus === 'pending' || assessment.configStatus === 'unverified') return 'Being re-checked'
  return assessment.configLastCheckedAt
    ? formatRelativeCheckedAt(assessment.configLastCheckedAt, now)
    : 'Verified'
}

export const getUpcomingVaultChanges = (assessment: VaultAssessment): UpcomingVaultChange[] => {
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
      const pending = observed.pendingValue ?? observed.value
      const summary = (finding.cause?.summary || finding.description)
        .replace(/^Pending change, acceptable from [^:]+:\s*/i, '')
      const parts = [date ? `from ${date}` : '', pending === undefined ? '' : String(pending), summary]
        .filter(Boolean)
      return {
        key: finding.key,
        text: `${parts.join(' · ')}${finding.outcome === 'fail' ? ' · would not pass the checks' : ''}`,
        failing: finding.outcome === 'fail',
      }
    })
}

export const getNotListedLine = (status: string | undefined, reason?: string | null): string | null => {
  if (status === 'pending_review') return 'This vault has not been checked yet, so it is not listed.'
  if (status === 'hidden') return `This vault is not listed${reason ? `: ${reason}` : '.'}${reason && !/[.!?]$/.test(reason) ? '.' : ''}`
  return null
}

export const getKnownUnlistedActionNotice = (
  addresses: readonly string[],
  source: string | undefined,
  visibility: Record<string, { status: string, reason?: string | null }> | undefined,
): string | null => {
  if (source !== 'v3' || !addresses.length) return null
  const lines = addresses.map((address) => {
    const verdict = visibility?.[address.toLowerCase()]
    return getNotListedLine(verdict?.status, verdict?.reason)
  })
  if (lines.some(line => line === null)) return null
  return lines.length === 1
    ? lines[0]!
    : 'These vaults are not listed. Review their vault checks before continuing.'
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
