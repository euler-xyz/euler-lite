import { createSSRApp, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('#components', () => ({ VaultAssessmentChecksModal: { render: () => null } }))
vi.mock('~/composables/useOracleAdapterAnchors', () => ({ useOracleAdapterAnchors: () => ({ hasAnchor: () => false }) }))

const VAULT = '0x2a356443fee07703266066c6bb1b11b82d8246ad'
const ADAPTER = '0x00000000000000000000000000000000000000a2'

const assessment = {
  assessed: true,
  configStatus: 'verified',
  checksStatus: 'warning',
  configContext: {
    outcome: 'pass',
    findings: [{
      key: 'oracle.adapters-checks',
      description: 'The oracle routes include adapters whose own checks are failing',
      outcome: 'fail',
      required: false,
      observed: { adapters: 1, failing: [{
        address: ADAPTER,
        checksStatus: 'warning',
        findings: [
          { key: 'feed-recognized', description: 'The connected price feed is not recognized.', severity: 'medium' },
          { key: 'max-staleness', description: 'Adapter\'s maximum staleness (31536000 s) must not exceed 604800 s.', severity: 'medium' },
        ],
      }] },
    }],
  },
  consistencyContext: null,
}

const render = async () => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useActivityNowMs', () => ref(Date.now()))
  vi.stubGlobal('useEulerLabels', () => ({
    vaultAssessments: ref({}),
    loadVaultAssessment: async () => {},
    getVaultAssessmentEntry: () => ({ status: 'available', assessment }),
    oracleAdapters: { [ADAPTER]: { label: 'Unknown AggregatorV3 Feed' } },
    loadOracleAdapters: async () => {},
  }))
  vi.stubGlobal('useClipboardCopy', () => ({ isCopied: () => false, copyToClipboard: async () => {} }))
  vi.stubGlobal('useVaultReferences', () => ({
    ensureResolved: () => {},
    oracleLinkFor: () => ({ path: `/borrow/0x01/${VAULT}`, hash: `#oracle-adapter-${ADAPTER}` }),
  }))
  vi.stubGlobal('useVaultCheckWeights', () => ({ weightOf: () => null }))
  const { default: Card } = await import('~/components/entities/vault/overview/VaultOverviewBlockVaultChecksCard.vue')
  const app = createSSRApp({ render: () => h(Card, { address: VAULT }) })
  app.component('SvgIcon', { render: () => h('span') })
  app.component('VaultReference', { props: { fallback: String }, setup: props => () => h('span', props.fallback) })
  app.component('UiModalPreviewTrigger', { setup: (_props, { slots }) => () => h('div', slots.default?.()) })
  app.component('NuxtLink', { props: { to: Object }, setup: (_props, { attrs, slots }) => () => h('a', attrs, slots.default?.()) })
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('vault checks card', () => {
  it('links a failing adapter to its oracle on a line of its own, after the sentence', async () => {
    const html = await render()
    const line = html.slice(html.indexOf('data-id="vault-check-line"'))
    const sentenceEnd = line.indexOf('604800 s')
    const link = line.indexOf('data-id="vault-check-oracle-link"')
    expect(sentenceEnd).toBeGreaterThan(-1)
    expect(link).toBeGreaterThan(sentenceEnd)
    expect(line.slice(sentenceEnd, link)).toContain('</span>')
    expect(html).toMatch(/data-id="vault-check-oracle-link"[^>]*>View oracle</)
    expect(html).not.toContain('Show in Oracles')
  })
})
