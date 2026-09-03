import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { EVault, OracleRouteStep } from '@eulerxyz/euler-v2-sdk'
import type { OracleAdapterMeta } from '~/entities/oracle'
import { OracleAdapterCheckSeverity } from '~/entities/oracle'
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

describe('buildOracleAdapterView', () => {
  it('enriches a recognized adapter from curated metadata', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: {
        oracle,
        base: weth,
        quote: usd,
        name: 'Chainlink WETH/USD',
        provider: 'Chainlink',
        methodology: 'Market price',
        label: 'Chainlink WETH/USD (Primary)',
        checks: [{ id: 'staleness', message: 'ok', pass: true, severity: OracleAdapterCheckSeverity.Info }],
      },
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
  })

  it('keeps the configured route separate from a proxy feed label', () => {
    const meta: Record<string, OracleAdapterMeta> = {
      [oracle.toLowerCase()]: {
        oracle,
        base: psUsdc,
        quote: usd,
        provider: 'Chainlink',
        methodology: 'Market Price',
        label: 'USDC / USD (0.25%, 82800s)',
      },
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
      [oracle.toLowerCase()]: {
        oracle,
        provider: 'Chainlink',
        checks: [{ id: 'staleness', message: 'stale', pass: false, severity: OracleAdapterCheckSeverity.High }],
      },
    }
    const view = buildOracleAdapterView(adapterStep(), meta)

    expect(view.checksStatus).toBe('negative')
    expect(view.failedChecks).toHaveLength(1)
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
