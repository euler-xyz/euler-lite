import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultAssessmentWarning from '~/components/entities/vault/VaultAssessmentWarning.vue'

const address = '0x00000000000000000000000000000000000000aa'

const renderWarning = (ready: boolean, options: { loadError?: string, status?: string, decidedBy?: string, hideChecks?: boolean, findings?: Array<{ key: string, description: string, outcome: string, required: boolean, exempted?: boolean }> } = {}) => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(ready),
    loadError: ref(options.loadError === undefined ? 'Unable to load vault verification. Please retry.' : options.loadError),
    source: ref('v3'),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: () => options.findings
      ? { status: 'available', assessment: { assessed: true, configStatus: 'verified', checksStatus: 'warning', configContext: { outcome: 'pass', findings: options.findings }, consistencyContext: null } }
      : { status: 'idle' },
    loadVaultAssessment: vi.fn(),
    visibility: ref({
      [address]: { status: options.status || 'warning', decidedBy: options.decidedBy || 'assessment', reason: 'Review the oracle.' },
    }),
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentWarning, { address, hideChecks: options.hideChecks }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    setup: (_, { slots }) => () => h('div', slots.default?.()),
  }))
  app.component('SvgIcon', { render: () => h('span') })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault verdict warning during a labels outage', () => {
  it('keeps the last-good warning until verification expires', async () => {
    expect(await renderWarning(true)).toMatch(/\sWarning<\/span>/)
    expect(await renderWarning(false)).not.toContain('vault-assessment-warning')
  })

  it('hides advisory warnings only when every failed finding is exempted', async () => {
    const accepted = { key: 'liquidation.max-discount', description: 'The maximum liquidation discount is between 5% and 20%', outcome: 'fail', required: false, exempted: true }
    const active = { key: 'oracle.liability-quote', description: 'The liability price quote executes on the oracle router', outcome: 'fail', required: false }
    expect(await renderWarning(true, { loadError: '', decidedBy: 'advisories', findings: [accepted] })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { loadError: '', decidedBy: 'advisories', findings: [accepted, active] })).toContain('vault-assessment-warning')
    expect(await renderWarning(true, { loadError: '', decidedBy: 'assessment', findings: [accepted] })).toContain('vault-assessment-warning')
  })

  it('keeps a not-listed badge on a card without vault-check warnings', async () => {
    expect(await renderWarning(true, { hideChecks: true })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { hideChecks: true, status: 'hidden' })).toContain('Not listed')
  })
})
