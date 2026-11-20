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

type Finding = { key: string, description: string, outcome: string, required: boolean, cause?: unknown }

const finding = (key: string, overrides: Partial<Finding> = {}): Finding => ({
  key,
  description: `Rule ${key}`,
  outcome: 'fail',
  required: false,
  cause: { code: 'generic', subject: null, summary: `Failure of ${key}`, remedy: null },
  ...overrides,
})

const syntheticEntry = (findings: Finding[]) => ({
  status: 'available',
  assessment: { vaultAddress: EUSDC_42, assessed: true, configStatus: 'unverified', checksStatus: 'warning', configContext: { outcome: 'fail', findings }, consistencyContext: null },
})

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

describe('summary of the failing checks under a card', () => {
  const findings = [
    finding('liquidation.cool-off'),
    finding('collateral.0x00000000000000000000000000000000000000c1.recognized', { required: true }),
    finding('hooks.zero-or-trusted', { required: true, cause: { code: 'exit-operations-disabled', subject: 'withdraw', summary: 'The vault is paused.', remedy: null } }),
    finding('oracle.liability-quote'),
    finding('collateral.0x00000000000000000000000000000000000000c2.recognized', { required: true }),
  ]

  it('shows the paused hooks first, then failures that affect listing, then the rest, three at most', async () => {
    const rows = rowTexts(await render(syntheticEntry(findings)))
    expect(rows).toEqual([
      'The vault is paused.',
      'Failure of collateral.0x00000000000000000000000000000000000000c1.recognized',
      'Failure of collateral.0x00000000000000000000000000000000000000c2.recognized',
      '+2 more · see checks',
    ])
  })

  it('opens the vault checks from a keyboard-reachable control named for what it shows', async () => {
    const html = await render(syntheticEntry(findings))
    expect(html).toContain('data-test-trigger="+2 more · see checks"')
    expect(html).toContain('data-test-modal="VaultAssessmentChecksModal"')
    expect(html).toContain(`data-test-assessment="${EUSDC_42}"`)
  })

  it('puts a failing check that affects listing before ones being re-checked', async () => {
    const rechecked = (key: string) => finding(key, { outcome: 'unknown', required: true })
    const rows = rowTexts(await render(syntheticEntry([
      rechecked('collateral.0x00000000000000000000000000000000000000d1.recognized'),
      rechecked('collateral.0x00000000000000000000000000000000000000d2.recognized'),
      finding('collateral.0x00000000000000000000000000000000000000d3.recognized', { required: true }),
    ])))
    expect(rows[0]).toBe('Failure of collateral.0x00000000000000000000000000000000000000d3.recognized')
  })

  it('lists every check without a more row when three or fewer fail', async () => {
    const html = await render(syntheticEntry(findings.slice(0, 3)))
    expect(rowTexts(html)).toHaveLength(3)
    expect(html).not.toContain('see checks')
  })

  it('counts the eUSDC-42 checks it leaves out', async () => {
    const rows = rowTexts(await render(assessmentEntry(EUSDC_42_RAW_ASSESSMENT)))
    expect(rows[0]).toBe(LIQUITY_HUB_PAUSED_REASON)
    expect(rows).toHaveLength(4)
    expect(rows[3]).toMatch(/^\+\d+ more · see checks$/)
  })
})
