import { createSSRApp, defineComponent, h, ref, type Component, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultAssessment } from '@eulerxyz/euler-v2-sdk'
import VaultAssessmentWarningLines from '~/components/entities/vault/VaultAssessmentWarningLines.vue'
import VaultAssessmentChecksModal from '~/components/entities/vault/overview/VaultAssessmentChecksModal.vue'
import VaultAssessmentCheckRow from '~/components/entities/vault/overview/VaultAssessmentCheckRow.vue'
import { formatUnboundedStaleness } from '~/entities/oracle'
import { EUSDC_42 } from '~/tests/fixtures/liquity-hub'
import { EUSDC_42_RAW_ASSESSMENT, assessmentEntry } from '~/tests/fixtures/v3-hidden-vault-assessments'
import {
  getAdapterCheckFailures,
  getVaultCheckWarningLines,
  orderVaultCheckLinesForSummary,
} from '~/utils/vault-assessment/presentation'

const opened = vi.hoisted(() => ({ assessment: undefined as unknown }))

vi.mock('#components', () => ({
  VaultAssessmentChecksModal: { name: 'VaultAssessmentChecksModal', render: () => null },
  UiModalPreviewTrigger: defineComponent({
    props: { modalData: Object as PropType<{ props: { assessment: unknown } }> },
    setup: (props, { slots }) => () => {
      opened.assessment = props.modalData?.props.assessment
      return h('span', slots.default?.())
    },
  }),
}))

const ADAPTER = '0x94a31084a0e8dbed217ee8763a20ab03e18b38f5'
const ADAPTER_LABEL = 'PT-sBOLD-1765325646 → BOLD price feed · Unknown AggregatorV3 Feed'
const entry = assessmentEntry(EUSDC_42_RAW_ASSESSMENT)
const assessment = entry.assessment as VaultAssessment

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const textOf = (html: string) => squash(html.replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
  .replace(/ ([.,:;])/g, '$1')

const references = () => ({
  ensureResolved: vi.fn(),
  adapterLabel: (address: string) => address.toLowerCase() === ADAPTER ? ADAPTER_LABEL : undefined,
  describe: (address: string, fallback?: string) => address.toLowerCase() === ADAPTER
    ? { kind: 'adapter', label: ADAPTER_LABEL }
    : { kind: 'address', label: fallback ?? address },
  oracleLinkFor: (line: { adapter?: string }) => line.adapter ? { path: `/borrow/0x01/${EUSDC_42}`, hash: `#oracle-adapter-${line.adapter}` } : undefined,
})

const render = (component: Component, props: Record<string, unknown>) => {
  const app = createSSRApp({ render: () => h(component, props) })
  app.config.warnHandler = () => undefined
  app.component('BaseModalWrapper', defineComponent({ setup: (_props, { slots }) => () => h('div', slots.default?.()) }))
  app.component('VaultAssessmentCheckRow', VaultAssessmentCheckRow)
  app.component('SvgIcon', { render: () => h('i') })
  app.component('NuxtLink', defineComponent({ props: { to: Object }, setup: (_props, { slots }) => () => h('a', { 'data-test-link': 'true' }, slots.default?.()) }))
  app.component('VaultReference', defineComponent({
    props: { address: String, fallback: String },
    setup: props => () => h('span', { 'data-reference': props.address?.toLowerCase() }, references().describe(props.address ?? '', props.fallback).label),
  }))
  return renderToString(app)
}

beforeEach(() => {
  opened.assessment = undefined
  vi.stubGlobal('useRouter', () => ({
    resolve: (to: { path?: string, hash?: string }) => ({ href: `${to.path ?? ''}${to.hash ?? ''}`, hash: to.hash ?? '' }),
    push: vi.fn(),
  }))
  vi.stubGlobal('useVaultReferences', references)
  vi.stubGlobal('useVaultCheckWeights', () => ({ weighAll: (subjects: unknown[]) => subjects.map(() => null), getUncoveredBorrows: () => null }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    vaultAssessments: ref({}),
    getVaultAssessmentEntry: () => entry,
    isVaultAssessmentAvailableForChain: () => true,
    oracleAdapters: {},
    loadOracleAdapters: async () => {},
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('"+K more · see checks" opens a view that shows everything the card leaves out', () => {
  it('lists, in the opened vault checks, every eUSDC-42 finding hidden from the card, adapter findings included', async () => {
    const card = await render(VaultAssessmentWarningLines, { vaults: [{ address: EUSDC_42, chainId: 1 }] })
    const hidden = orderVaultCheckLinesForSummary(getVaultCheckWarningLines(assessment)).slice(3)
    expect(card).toContain(`+${hidden.length} more · see checks`)
    expect(hidden.some(line => line.adapter?.toLowerCase() === ADAPTER)).toBe(true)

    const view = textOf(await render(VaultAssessmentChecksModal, { assessment: opened.assessment }))
    const adapterFinding = assessment.configContext!.findings.find(finding => finding.key === 'oracle.adapters-checks')!
    for (const line of hidden) {
      if (!line.adapter) {
        expect(view).toContain(squash(line.text))
        continue
      }
      const failure = getAdapterCheckFailures(adapterFinding).find(item => item.address.toLowerCase() === line.adapter!.toLowerCase())!
      for (const check of failure.findings) expect(view).toContain(formatUnboundedStaleness(check.description))
    }
    expect(view).toContain('its quote reverts are no longer excused')
  })

  it('names the adapter by its pair, gives each finding its severity and drops the abbreviated summary', async () => {
    const view = await render(VaultAssessmentChecksModal, { assessment })
    const adapters = view.slice(view.indexOf('data-id="vault-check-adapter"'))
    expect(adapters).toContain(`data-reference="${ADAPTER}"`)
    expect(adapters).toContain(escapeHtml(ADAPTER_LABEL))
    expect(adapters).toContain('Adapter&#39;s maximum staleness (unbounded) must not exceed 604800 s.')
    expect([...adapters.matchAll(/data-id="vault-check-adapter-finding"/g)]).toHaveLength(4)
    expect([...adapters.matchAll(/data-severity="high"/g)]).toHaveLength(2)
    expect(view).not.toContain('and 1 more.')
    expect(adapters).toContain('data-id="vault-check-oracle-link"')
  })
})
