import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultAssessmentChecksField from '~/components/entities/vault/VaultAssessmentChecksField.vue'

vi.mock('#components', () => ({ VaultAssessmentChecksModal: {} }))

const address = '0x00000000000000000000000000000000000000aa'

const render = (findings: Array<Record<string, unknown>>, errorTone: boolean, missingAssessment = false) => {
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    visibility: ref({}),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: () => ({ status: 'available', assessment: missingAssessment ? undefined : { assessed: true, configStatus: 'verified', checksStatus: 'warning', configContext: { outcome: 'pass', findings }, consistencyContext: null } }),
    loadVaultAssessment: vi.fn(),
    isVaultAssessmentAvailableForChain: () => true,
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentChecksField, { address, chainId: 1, errorTone }) })
  for (const name of ['UiModalPreviewTrigger', 'UiHoverPreviewTooltip']) {
    app.component(name, defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }))
  }
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault checks cell', () => {
  it('shows a completed missing assessment as not assessed', async () => {
    const html = await render([], false, true)
    expect(html).toContain('Not assessed')
    expect(html).not.toContain('Checking…')
  })

  it('counts accepted exceptions as passed and colours a failure by the vault status', async () => {
    const accepted = { key: 'liquidation.max-discount', description: 'd', outcome: 'fail', required: false, exempted: true }
    const passed = { key: 'oracle.liability-quote', description: 'd', outcome: 'pass', required: true }
    const failed = { key: 'liquidation.cool-off', description: 'd', outcome: 'fail', required: false }
    expect(await render([accepted, passed], false)).toContain('2 passed')
    const warning = await render([failed, passed], false)
    expect(warning).toContain('1 failed')
    expect(warning).toContain('text-warning-500')
    const error = await render([failed, passed], true)
    expect(error).toContain('1 failed')
    expect(error).toContain('text-error-500')
  })
})
