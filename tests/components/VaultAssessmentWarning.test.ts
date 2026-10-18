import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultAssessmentWarning from '~/components/entities/vault/VaultAssessmentWarning.vue'

const address = '0x00000000000000000000000000000000000000aa'

const renderWarning = (ready: boolean, options: { loadError?: string, status?: string, decidedBy?: string, reason?: string | null, hideChecks?: boolean, findings?: Array<{ key: string, description: string, outcome: string, required: boolean, exempted?: boolean }> } = {}) => {
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
      [address]: { status: options.status || 'warning', decidedBy: options.decidedBy || 'assessment', reason: options.reason === undefined ? 'Review the oracle.' : options.reason },
    }),
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentWarning, { address, hideChecks: options.hideChecks }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (props, { slots }) => () => h('div', { 'data-title': props.title, 'data-text': props.text }, slots.default?.()),
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

  it('keeps a flagged badge on a card without vault-check warnings', async () => {
    expect(await renderWarning(true, { hideChecks: true })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { hideChecks: true, status: 'hidden' })).toMatch(/\sFlagged<\/span>/)
  })
})

describe('flagged vault badge', () => {
  it('calls a hidden vault flagged and explains it with the V3 reason', async () => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', reason: 'A required check failed.' })
    expect(html).toMatch(/\sFlagged<\/span>/)
    expect(html).toContain('data-title="Vault flagged"')
    expect(html).toContain('data-text="A required check failed."')
    expect(html).not.toContain('Not listed')
    expect(html).not.toContain('not listed')
  })

  it('falls back to the flagged sentence when V3 gives no reason', async () => {
    const html = await renderWarning(true, { status: 'hidden', decidedBy: 'config-failed', reason: null })
    expect(html).toContain('data-text="Euler&#39;s checks flagged this vault."')
  })

  it('shows no badge for a pending-review or visible vault', async () => {
    expect(await renderWarning(true, { status: 'pending_review', decidedBy: 'awaiting-verification' })).not.toContain('vault-assessment-warning')
    expect(await renderWarning(true, { status: 'visible', decidedBy: 'verified' })).not.toContain('vault-assessment-warning')
  })

  it('keeps the deprecated badge for a deprecated verdict', async () => {
    const html = await renderWarning(true, { status: 'warning', decidedBy: 'deprecated', reason: 'Deprecated.' })
    expect(html).toMatch(/\sDeprecated<\/span>/)
    expect(html).not.toContain('Flagged')
  })
})
