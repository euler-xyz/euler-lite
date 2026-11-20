import { createSSRApp, defineComponent, h, ref, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VaultAssessmentWarningLines from '~/components/entities/vault/VaultAssessmentWarningLines.vue'
import { EUSDC_42, LIQUITY_HUB_PAUSED_REASON } from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT, assessmentEntry } from '~/tests/fixtures/v3-hidden-vault-assessments'
import { getFlaggedVaultLine } from '~/utils/vault-assessment/flagged'

vi.mock('#components', () => ({
  VaultAssessmentChecksModal: { name: 'VaultAssessmentChecksModal', render: () => null },
  UiModalPreviewTrigger: defineComponent({
    props: { component: Object, modalData: Object as PropType<{ props: { assessment: { vaultAddress: string } } }>, ariaLabel: String },
    setup: (props, { slots }) => () => h('span', {
      'data-test-trigger': props.ariaLabel,
      'data-test-modal': (props.component as { name?: string } | undefined)?.name,
      'data-test-assessment': props.modalData?.props.assessment.vaultAddress,
    }, slots.default?.()),
  }),
}))

const render = (entry: unknown, unknown: { unverified?: boolean, cause?: string } = {}) => {
  vi.stubGlobal('useVaultReferences', () => ({ ensureResolved: vi.fn() }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: () => entry,
    isVaultAssessmentAvailableForChain: () => true,
    oracleAdapters: {},
    loadOracleAdapters: async () => {},
  }))
  const app = createSSRApp({ render: () => h(VaultAssessmentWarningLines, { vaults: [{ address: EUSDC_42, chainId: 1, ...unknown }] }) })
  app.config.warnHandler = () => undefined
  app.component('SvgIcon', { render: () => h('i') })
  app.component('VaultReference', defineComponent({ props: { fallback: String }, setup: props => () => h('span', props.fallback) }))
  return renderToString(app)
}

const rowTexts = (html: string) => [...html.matchAll(/data-tone="[^"]+"[^>]*>([\s\S]*?)<\/div>/g)]
  .map(match => match[1]!.replace(/<[^>]+>/g, '').replace(/&#39;/g, '\'').trim())

afterEach(() => vi.unstubAllGlobals())

describe('cause line of an unknown vault', () => {
  it('leaves out the cause when a shown check says the same thing', async () => {
    const html = await render(assessmentEntry(EUSDC_42_RAW_ASSESSMENT), { unverified: true, cause: getFlaggedVaultLine(LIQUITY_HUB_PAUSED_REASON) })
    const rows = rowTexts(html)
    expect(rows[0]).toBe(LIQUITY_HUB_PAUSED_REASON)
    expect(rows.some(row => row.startsWith('Euler\'s checks flagged this vault'))).toBe(false)
  })

  it('keeps the cause when it adds something the checks do not say', async () => {
    const cause = getFlaggedVaultLine('The vault was marked as not to be listed.')
    const rows = rowTexts(await render(assessmentEntry(EUSDC_42_RAW_ASSESSMENT), { unverified: true, cause }))
    expect(rows[0]).toBe(cause)
  })
})
