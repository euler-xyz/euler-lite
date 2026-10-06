import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import VaultAssessmentWarningLines from '~/components/entities/vault/VaultAssessmentWarningLines.vue'

const usdt = '0x00000000000000000000000000000000000000aa'
const weth = '0x00000000000000000000000000000000000000bb'

const assessmentWith = (findings: Array<Record<string, unknown>>) => ({
  status: 'available',
  assessment: { assessed: true, configStatus: 'verified', checksStatus: 'warning', configContext: { outcome: 'pass', findings }, consistencyContext: null },
})

const render = (entries: Record<string, ReturnType<typeof assessmentWith>>, showSymbol: boolean, unknown: Partial<{ unverified: boolean, cause: string }> = {}) => {
  vi.stubGlobal('useClipboardCopy', () => ({ isCopied: () => false, copyToClipboard: vi.fn(async () => {}) }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: (_chainId: number, address: string) => entries[address.toLowerCase()] ?? { status: 'idle' },
    isVaultAssessmentAvailableForChain: () => true,
    oracleAdapters: { '0x00000000000000000000000000000000000000a2': { label: 'Unknown AggregatorV3 Feed' } },
    loadOracleAdapters: async () => {},
  }))
  const app = createSSRApp({
    render: () => h(VaultAssessmentWarningLines, {
      vaults: [{ address: usdt, chainId: 1, symbol: 'USDT', ...unknown }, { address: weth, chainId: 1, symbol: 'WETH' }],
      showSymbol,
    }),
  })
  app.component('SvgIcon', { render: () => h('span') })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault assessment warning lines', () => {
  it('lists each failing check under the card, prefixed with the vault symbol for a pair', async () => {
    const html = await render({
      [usdt]: assessmentWith([{ key: 'liquidation.cool-off', description: 'The liquidation cool-off is 3600 seconds, outside the 1 to 600 Euler accepts.', outcome: 'fail', required: false }]),
      [weth]: assessmentWith([{ key: 'liquidation.max-discount', description: 'The maximum liquidation discount is 0%.', outcome: 'fail', required: false, exempted: true }]),
    }, true)
    expect(html).toContain('vault-assessment-warning-lines')
    expect(html).toContain('USDT')
    expect(html).toContain('The liquidation cool-off is 3600 seconds')
    expect(html).not.toContain('WETH')
    expect(html).not.toContain('maximum liquidation discount')
  })

  it('states why an unknown vault is unknown first and lists its failing checks as errors', async () => {
    const html = await render({
      [usdt]: assessmentWith([{ key: 'liquidation.max-discount', description: 'The maximum liquidation discount is 3.5%, outside the 5% to 20% Euler accepts.', outcome: 'fail', required: false }]),
    }, false, { unverified: true, cause: 'This vault is not listed: the configuration check failed.' })
    const cause = html.indexOf('This vault is not listed: the configuration check failed.')
    const check = html.indexOf('The maximum liquidation discount is 3.5%')
    expect(cause).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(cause)
    expect(html).toContain('data-tone="error"')
    expect(html).not.toContain('data-tone="warning"')
  })

  it('shows the undecided required check that keeps an unknown vault unlisted as an error, by its cause', async () => {
    const html = await render({
      [usdt]: assessmentWith([{ key: 'oracle.adapters-recognized', description: 'Some oracle route adapters have not been assessed yet', outcome: 'unknown', required: true, cause: { code: 'adapters-pending', subject: 'vault', summary: 'Euler has not finished checking 4 adapters on the oracle routes.', remedy: null } }]),
    }, false, { unverified: true, cause: 'This vault is not listed in the published vault labels.' })
    expect(html).toContain('Euler has not finished checking 4 adapters on the oracle routes.')
    expect(html).toContain('data-tone="error"')
    expect(html).not.toContain('data-tone="muted"')
  })

  it('names a failing oracle adapter by its label and leaves below-threshold adapters to the Oracles section', async () => {
    const feed = { key: 'feed-recognized', description: 'The connected price feed is not recognized.', severity: 'medium' }
    const live = { key: 'quote-liveness', description: 'The quote is stale.', severity: 'medium' }
    const html = await render({
      [usdt]: assessmentWith([{ key: 'oracle.adapters-checks', description: 'The oracle routes include adapters whose own checks are failing', outcome: 'fail', required: false, observed: { adapters: 2, failing: [
        { address: '0x00000000000000000000000000000000000000a1', checksStatus: 'warning', findings: [feed] },
        { address: '0x00000000000000000000000000000000000000a2', checksStatus: 'warning', findings: [feed, live] },
      ] } }]),
    }, false)
    expect(html).toContain('Unknown AggregatorV3 Feed')
    expect(html).toContain(`aria-label="Copy address ${getAddress('0x00000000000000000000000000000000000000a2')}"`)
    expect(html).toContain('The quote is stale')
    expect(html).not.toContain('0x0000…00a1')
    expect(html).not.toContain('oracle routes include adapters')
  })

  it('renders nothing when no vault has a failing check', async () => {
    const html = await render({ [usdt]: assessmentWith([{ key: 'oracle.liability-quote', description: 'ok', outcome: 'pass', required: true }]) }, false)
    expect(html).not.toContain('vault-assessment-warning-lines')
  })
})
