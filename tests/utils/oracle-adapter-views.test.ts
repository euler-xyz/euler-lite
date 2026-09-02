import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { EVault, OracleRouteStep } from '@eulerxyz/euler-v2-sdk'
import type { OracleAdapterMeta } from '~/entities/oracle'
import { OracleAdapterCheckOutcome, OracleAdapterCheckSeverity } from '~/entities/oracle'
import { buildOracleAdapterView, collectOracleRouteSteps } from '~/utils/oracle-adapter-views'

const oracle = '0x000000000000000000000000000000000000A111' as Address
const weth = '0x000000000000000000000000000000000000E711' as Address
const psUsdc = '0x000000000000000000000000000000000000C011' as Address
const usd = '0x0000000000000000000000000000000000000051' as Address

const adapterStep = (overrides: Partial<OracleRouteStep> = {}): OracleRouteStep => ({
  kind: 'adapter',
  oracle,
  base: weth,
  quote: usd,
  name: 'ChainlinkOracle',
  ...overrides,
} as OracleRouteStep)

const assessed = (overrides: Partial<OracleAdapterMeta> = {}): OracleAdapterMeta => ({
  oracle,
  recognized: true,
  checksStatus: null,
  inActiveRoute: true,
  checks: [],
  ...overrides,
})

describe('buildOracleAdapterView', () => {
  it('enriches a recognized adapter from curated metadata', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        base: weth,
        quote: usd,
        name: 'Chainlink WETH/USD',
        provider: 'Chainlink',
        methodology: 'Market price',
        label: 'Chainlink WETH/USD (Primary)',
        checksStatus: 'positive',
        checks: [{ id: 'staleness', message: 'ok', outcome: OracleAdapterCheckOutcome.Pass, severity: OracleAdapterCheckSeverity.Info }],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.provider).toBe('Chainlink')
    expect(view.name).toBe('Chainlink WETH/USD')
    expect(view.isCustomAdapter).toBe(false)
    expect(view.methodology).toBe('Market price')
    expect(view.logo).toBe('https://v3.euler.finance/v3/images/oracle-providers/chainlink')
    expect(view.label).toEqual({ primary: 'Chainlink WETH/USD', suffix: '(Primary)' })
    expect(view.checksStatus).toBe('positive')
  })

  it('flags an adapter with no curated entry as custom (no onchain-name leak, no logo)', () => {
    const view = buildOracleAdapterView(adapterStep(), {})

    expect(view.name).toBeUndefined()
    expect(view.provider).toBeUndefined()
    expect(view.isCustomAdapter).toBe(true)
    expect(view.logo).toBeUndefined()
    expect(view.label).toBeUndefined()
    expect(view.checksStatus).toBeNull()
    expect(view.assessmentState).toBe('unassessed')
    expect(view.reason).toBeUndefined()
  })

  it('does not let unrecognized decoded config influence labels or price direction', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        recognized: false,
        base: usd,
        quote: weth,
        label: 'Spoofed feed',
        provider: 'Spoofed provider',
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.isCustomAdapter).toBe(true)
    expect(view.assessmentState).toBe('unrecognized')
    expect(view.label).toBeUndefined()
    expect(view.invertPrice).toBe(false)
    expect(view.assessmentPairMatchesRoute).toBeNull()
    expect(view.checks).toEqual([])
    expect(view.checksStatus).toBeNull()
  })

  it('exposes only the identity findings and the reason for an unrecognized assessment', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        recognized: false,
        reason: 'source-provenance: Runtime bytecode does not match any known adapter build.',
        lastCheckedAt: '2026-09-01T12:00:00.000Z',
        checks: [
          { id: 'adapter-exists', message: 'has code', outcome: OracleAdapterCheckOutcome.Pass, severity: OracleAdapterCheckSeverity.High },
          { id: 'source-provenance', message: 'unknown build', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High },
          { id: 'quote-liveness', message: 'quotes', outcome: OracleAdapterCheckOutcome.Pass, severity: OracleAdapterCheckSeverity.Medium },
        ],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.assessmentState).toBe('unrecognized')
    expect(view.isCustomAdapter).toBe(true)
    expect(view.checks?.map(check => check.id)).toEqual(['adapter-exists', 'source-provenance'])
    expect(view.checksStatus).toBeNull()
    expect(view.failedChecks).toHaveLength(0)
    expect(view.passedChecks).toBe(0)
    expect(view.reason).toBe('Source provenance: Runtime bytecode does not match any known adapter build.')
    expect(view.lastCheckedAt).toBe('2026-09-01T12:00:00.000Z')
  })

  it('keeps the adjudication-mismatch finding visible for a de-recognized custom adapter', () => {
    // Shape emitted by Data V3 policy v4 when an adjudicated custom adapter's
    // deployed bytecode no longer matches the pinned fingerprint.
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        recognized: false,
        reason: 'custom-adapter-adjudicated: The deployed runtime bytecode does not match the adjudicated fingerprint.',
        checks: [
          { id: 'adapter-exists', message: 'has code', outcome: OracleAdapterCheckOutcome.Pass, severity: OracleAdapterCheckSeverity.High },
          { id: 'custom-adapter-adjudicated', message: 'fingerprint mismatch', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High },
          { id: 'adapter-class-known', message: 'not a known class', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High },
          { id: 'source-provenance', message: 'no known build', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High },
        ],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.assessmentState).toBe('unrecognized')
    expect(view.checks?.map(check => check.id)).toEqual([
      'adapter-exists',
      'custom-adapter-adjudicated',
      'adapter-class-known',
      'source-provenance',
    ])
    expect(view.reason).toBe('Custom adapter adjudicated: The deployed runtime bytecode does not match the adjudicated fingerprint.')
  })

  it('counts only passing health findings for a positive verdict', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        provider: 'Pendle',
        checksStatus: 'positive',
        checks: [
          { id: 'adapter-exists', message: 'ok', outcome: OracleAdapterCheckOutcome.Pass, severity: OracleAdapterCheckSeverity.High },
          { id: 'pendle-market-expired', message: 'matured', outcome: OracleAdapterCheckOutcome.NotApplicable, severity: OracleAdapterCheckSeverity.Info },
        ],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.assessmentState).toBe('recognized')
    expect(view.passedChecks).toBe(1)
    expect(view.checks).toHaveLength(2)
  })

  it('keeps the configured route separate from a proxy feed label', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        base: psUsdc,
        quote: usd,
        provider: 'Chainlink',
        methodology: 'Market Price',
        label: 'USDC / USD (0.25%, 82800s)',
      }),
    }
    const view = buildOracleAdapterView(adapterStep({ base: psUsdc }), meta)

    expect(view.label).toEqual({ primary: 'USDC / USD', suffix: '(0.25%, 82800s)' })
    expect(view.base).toBe(psUsdc)
    expect(view.quote).toBe(usd)
  })

  it('keeps the decoded name and "Exchange Rate" methodology for vault (ERC-4626) steps', () => {
    const view = buildOracleAdapterView(adapterStep({ kind: 'vault', name: 'ERC4626Vault' }), {})

    expect(view.name).toBe('ERC4626Vault')
    expect(view.isCustomAdapter).toBe(false)
    expect(view.methodology).toBe('Exchange Rate')
  })

  it('marks a high-severity failing check as a negative status', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        provider: 'Chainlink',
        checksStatus: 'negative',
        checks: [{ id: 'staleness', message: 'stale', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High }],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.checksStatus).toBe('negative')
    expect(view.failedChecks).toHaveLength(1)
  })

  it('uses the V3 aggregate for unknown outcomes instead of treating them as failures', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        provider: 'Chainlink',
        checksStatus: 'warning',
        checks: [{ id: 'liveness', message: 'inconclusive', outcome: OracleAdapterCheckOutcome.Unknown, severity: OracleAdapterCheckSeverity.Medium }],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.checksStatus).toBe('warning')
    expect(view.failedChecks).toHaveLength(0)
    expect(view.unknownChecks).toHaveLength(1)
  })

  it('does not apply an assessment health verdict to an unrelated route pair', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: assessed({
        base: psUsdc,
        quote: usd,
        label: 'psUSDC / USD',
        checksStatus: 'negative',
        checks: [{ id: 'quote-liveness', message: 'failed', outcome: OracleAdapterCheckOutcome.Fail, severity: OracleAdapterCheckSeverity.High }],
      }),
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.assessmentPairMatchesRoute).toBe(false)
    expect(view.assessmentState).toBe('recognized')
    expect(view.label).toBeUndefined()
    expect(view.checks).toBeUndefined()
    expect(view.checksStatus).toBeNull()
    expect(view.failedChecks).toHaveLength(0)
    expect(view.lastCheckedAt).toBeUndefined()
  })
})

describe('collectOracleRouteSteps', () => {
  const debtStep = adapterStep({ oracle: '0x00000000000000000000000000000000000000d1' as Address })
  const collateralStep = adapterStep({ oracle: '0x00000000000000000000000000000000000000c1' as Address, base: usd, quote: weth })

  const makeVault = (collateralAddr: string): EVault => ({
    debtPricingOracleRoute: { steps: [debtStep] },
    collaterals: [
      { address: collateralAddr, oracleRoute: { steps: [collateralStep] } },
    ],
  } as unknown as EVault)

  it('returns the debt route when there are no collaterals', () => {
    const steps = collectOracleRouteSteps([makeVault('0xdead')])
    expect(steps).toEqual([debtStep])
  })

  it('combines debt + collateral routes for the pair', () => {
    const collateralAddr = '0x00000000000000000000000000000000000000cc'
    const collateralVault = { address: collateralAddr } as unknown as EVault
    const steps = collectOracleRouteSteps([makeVault(collateralAddr)], [collateralVault])

    expect(steps).toContain(debtStep)
    expect(steps).toContain(collateralStep)
    expect(steps).toHaveLength(2)
  })

  it('dedupes identical steps across vaults', () => {
    const v = makeVault('0xdead')
    const steps = collectOracleRouteSteps([v, v])
    expect(steps).toHaveLength(1)
  })
})
