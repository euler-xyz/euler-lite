import type { Address } from 'viem'
import type { EVault, OracleRouteStep, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import {
  OracleAdapterCheckOutcome,
  resolveOracleAdapterIdentity,
  type OracleAdapterCheck,
  type OracleAdapterMeta,
} from '~/entities/oracle'
import { getOracleProviderLogo } from '~/entities/oracle-providers'
import { shouldInvertOraclePrice } from '~/utils/oracle-label'
import { getCollateralOracleRouteSteps, getDebtOracleRouteSteps, isOracleAdapterRouteStep } from '~/utils/oracle-route-steps'
import { getOracleRouteStepKey } from '~/composables/useOracleAdapterPrices'

// Single source of truth for the oracle adapters shown on the borrow page's
// Oracles block AND in the explore matrix. Both surfaces must agree on which
// adapters price a given (liability, collateral) pair, so the collection and
// per-step enrichment live here rather than being duplicated per component.

export type OracleAdapterView = {
  key: string
  kind: OracleRouteStep['kind']
  oracle: Address
  base: Address
  quote: Address
  metaBase?: Address
  metaQuote?: Address
  name?: string
  provider?: string
  isCustomAdapter: boolean
  methodology?: string
  logo?: string
  label?: { primary: string, suffix?: string }
  invertPrice: boolean
  checks?: OracleAdapterCheck[]
  checksStatus: 'positive' | 'warning' | 'negative' | null
  failedChecks: OracleAdapterCheck[]
  unknownChecks: OracleAdapterCheck[]
  assessmentPairMatchesRoute: boolean | null
  policyVersion?: number
  lastCheckedAt?: string
}

// Collects the deduped oracle route steps that price the given liability
// vault(s) together with the given collateral vault(s): each liability's own
// asset->unit-of-account (debt) route plus the collateral->unit-of-account
// route for every collateral. Mirrors what the borrow page shows for a pair.
export const collectOracleRouteSteps = (
  vaults: EVault[],
  collateralVaults: (EVault | SecuritizeCollateralVault)[] = [],
): OracleRouteStep[] => {
  const deduped = new Map<string, OracleRouteStep>()
  for (const vault of vaults) {
    const steps: OracleRouteStep[] = [...getDebtOracleRouteSteps(vault)]
    for (const collateralVault of collateralVaults) {
      steps.push(...getCollateralOracleRouteSteps(vault, collateralVault))
    }
    for (const step of steps) {
      const key = getOracleRouteStepKey(step)
      if (!deduped.has(key)) deduped.set(key, step)
    }
  }
  return [...deduped.values()]
}

const parseAdapterLabel = (label: string | undefined): { primary: string, suffix?: string } | undefined =>
  label
    ? {
        primary: label.split('(')[0].trimEnd(),
        suffix: label.includes('(') ? label.slice(label.indexOf('(')).trim() : undefined,
      }
    : undefined

const assessmentPairMatchesRoute = (
  step: OracleRouteStep,
  meta: OracleAdapterMeta | undefined,
): boolean | null => {
  if (!meta?.base || !meta.quote) return null
  const stepBase = step.base.toLowerCase()
  const stepQuote = step.quote.toLowerCase()
  const metaBase = meta.base.toLowerCase()
  const metaQuote = meta.quote.toLowerCase()
  return (
    (stepBase === metaBase && stepQuote === metaQuote)
    || (stepBase === metaQuote && stepQuote === metaBase)
  )
}

// Enriches one oracle route step into a display view, resolving adapter
// identity and health from Data V3 while keeping the live decoded route as a
// separate input.
export const buildOracleAdapterView = (
  step: OracleRouteStep,
  oracleAdapters: Record<string, OracleAdapterMeta>,
): OracleAdapterView => {
  const isAdapter = isOracleAdapterRouteStep(step)
  const meta = isAdapter ? oracleAdapters[step.oracle.toLowerCase()] : undefined
  const { name, provider, isCustomAdapter } = resolveOracleAdapterIdentity(step, meta, isAdapter)
  const trustedMeta = meta?.recognized ? meta : undefined
  const pairMatches = assessmentPairMatchesRoute(step, trustedMeta)
  const assessmentApplies = pairMatches !== false
  const checks = assessmentApplies ? trustedMeta?.checks : undefined
  return {
    key: getOracleRouteStepKey(step),
    kind: step.kind,
    oracle: step.oracle,
    base: step.base,
    quote: step.quote,
    metaBase: trustedMeta?.base,
    metaQuote: trustedMeta?.quote,
    name,
    provider,
    isCustomAdapter,
    methodology: trustedMeta?.methodology || (step.kind === 'vault' ? 'Exchange Rate' : undefined),
    logo: getOracleProviderLogo(provider, name),
    label: parseAdapterLabel(assessmentApplies ? trustedMeta?.label : undefined),
    invertPrice: shouldInvertOraclePrice({
      metaBase: trustedMeta?.base,
      metaQuote: trustedMeta?.quote,
      callerBase: step.base,
      callerQuote: step.quote,
    }),
    checks,
    checksStatus: trustedMeta && assessmentApplies ? trustedMeta.checksStatus : null,
    failedChecks: checks?.filter(c => c.outcome === OracleAdapterCheckOutcome.Fail) ?? [],
    unknownChecks: checks?.filter(c => c.outcome === OracleAdapterCheckOutcome.Unknown) ?? [],
    assessmentPairMatchesRoute: pairMatches,
    policyVersion: assessmentApplies ? trustedMeta?.policyVersion : undefined,
    lastCheckedAt: assessmentApplies ? trustedMeta?.lastCheckedAt : undefined,
  }
}

export const buildOracleAdapterViews = (
  steps: OracleRouteStep[],
  oracleAdapters: Record<string, OracleAdapterMeta>,
): OracleAdapterView[] => steps.map(step => buildOracleAdapterView(step, oracleAdapters))
