import { createSSRApp, defineComponent, h, ref, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import VaultOverviewBlockGeneral from '~/components/entities/vault/overview/VaultOverviewBlockGeneral.vue'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { useFlaggedVault } from '~/composables/useFlaggedVault'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaultTypeBadges } from '~/composables/useVaultTypeBadges'
import { useVaults } from '~/composables/useVaults'
import {
  EUSDC_42,
  LIQUITY_HUB_ENTITY,
  LIQUITY_HUB_GOVERNOR,
  LIQUITY_HUB_PRODUCT,
  liquityHubHiddenVerdict,
  makeEusdc42,
} from '~/tests/fixtures/liquity-hub'
import {
  EUSDC_42_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT,
  IDLE_CREDIT_VAULT_RAW_ASSESSMENT,
  IDLE_CREDIT_VAULT_VERDICT,
  IDLE_ENTITY,
  IDLE_GOVERNOR,
  IDLE_PRODUCT,
  assessmentEntry,
  makeIdleCreditVault,
} from '~/tests/fixtures/v3-hidden-vault-assessments'

vi.mock('#components', () => ({ AccessControlBadge: {}, CyclicalNoteBadge: {}, GovernanceLimitedBadge: {}, KeyringBadge: {} }))
vi.mock('~/utils/sdk-prices', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/sdk-prices')>()),
  formatAssetValue: async () => ({ hasPrice: false, usdValue: 0, display: '-' }),
}))

const k3 = { name: 'K3 Capital', addresses: { [LIQUITY_HUB_GOVERNOR]: 'K3 governor' } }
const idle = { name: 'Idle DAO', addresses: { [IDLE_GOVERNOR]: 'Idle DAO Limited Governor' } }

const setLabels = (
  verdicts: Record<string, unknown>,
  entries: Record<string, ReturnType<typeof assessmentEntry>> = {},
) => {
  __setEulerLabelsDataForTest({
    source: 'v3',
    entities: { [LIQUITY_HUB_ENTITY]: k3, [IDLE_ENTITY]: idle },
    products: {
      [LIQUITY_HUB_PRODUCT]: { name: 'Liquity Hub', entity: LIQUITY_HUB_ENTITY, vaults: [EUSDC_42] },
      [IDLE_PRODUCT]: { name: 'Idle Credit Vaults', entity: IDLE_ENTITY, vaults: [IDLE_CREDIT_VAULT] },
    },
    managingEntityByVault: { [EUSDC_42.toLowerCase()]: LIQUITY_HUB_ENTITY, [IDLE_CREDIT_VAULT.toLowerCase()]: IDLE_ENTITY },
    visibility: verdicts,
  } as unknown as Partial<PublicEulerLabelsData>)
  vi.stubGlobal('useEulerLabels', () => ({
    ...useEulerLabels(),
    getVaultAssessmentEntry: (_chainId: number, address: string) => entries[address.toLowerCase()] ?? { status: 'idle' },
  }))
}
const setEusdc42Labels = (decidedBy: string) => setLabels(
  { [EUSDC_42.toLowerCase()]: liquityHubHiddenVerdict(decidedBy) },
  { [EUSDC_42.toLowerCase()]: assessmentEntry(EUSDC_42_RAW_ASSESSMENT) },
)

const LabelValue = defineComponent({
  props: { label: String, value: String },
  setup: (props, { slots }) => () => h('div', { 'data-label': props.label }, [props.value, slots.default?.()]),
})

const render = (vault: EVault) => {
  const app = createSSRApp({ render: () => h(VaultOverviewBlockGeneral, { vault }) })
  app.component('VaultOverviewAccordionSection', defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) }))
  app.component('VaultOverviewLabelValue', LabelValue)
  app.component('VaultTypeChip', defineComponent({
    props: { type: String },
    setup: props => () => h('span', { 'data-test-chip': props.type }),
  }))
  app.component('CuratorEntityLink', defineComponent({
    props: { entities: { type: Array as PropType<Array<{ name: string }>>, required: true } },
    setup: props => () => h('span', { 'data-test-curator': props.entities.map(entity => entity.name).join(',') }),
  }))
  app.component('SafeAccountBadge', defineComponent({
    props: { address: String },
    setup: props => () => h('span', { 'data-test-safe': props.address }),
  }))
  for (const name of ['VaultDeprecationBanner', 'LiquidationCoverageNotice', 'VaultPublicNotice', 'UiIcon', 'VaultExposureSummary', 'NuxtLink']) {
    app.component(name, { render: () => h('span') })
  }
  return renderToString(app)
}

const curatorCell = (html: string) => html.match(/data-label="Curator">(.*?)<\/div>/)?.[1] ?? ''
const vaultTypeCell = (html: string) => html.match(/data-label="Vault type">(.*?)<\/div>/)?.[1] ?? ''

beforeEach(() => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useChainConfig', () => ({ deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }))
  vi.stubGlobal('useEulerSdk', () => ({ getEulerSdk: vi.fn(), getEulerSdkForChain: vi.fn() }))
  vi.stubGlobal('useEulerLabels', useEulerLabels)
  vi.stubGlobal('useVaultRegistry', useVaultRegistry)
  vi.stubGlobal('useVaults', useVaults)
  vi.stubGlobal('useFlaggedVault', useFlaggedVault)
  vi.stubGlobal('useVaultTypeBadges', useVaultTypeBadges)
  vi.stubGlobal('useRoute', () => ({ query: { network: '1' } }))
  vi.stubGlobal('useDeployConfig', () => ({ enableEntityBranding: true, enableVaultType: true }))
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(),
    getOpenInterestForVault: () => ({}),
    hasError: ref(false),
    isLoaded: ref(false),
    isOpenInterestEnabled: ref(false),
  }))
  vi.stubGlobal('useVaultBadDebt', () => ({
    getVaultBadDebt: () => undefined,
    isBadDebtEnabled: ref(false),
    isBadDebtLoading: ref(false),
    loadBadDebtForChain: vi.fn(),
  }))
  vi.stubGlobal('useVaultAssessmentEvidence', () => ({ assessment: ref(null), fallbackReady: ref(false) }))
  vi.stubGlobal('formatUsdValue', (value: number) => `$${value}`)
})

afterEach(() => {
  useVaultRegistry().clear()
  vi.unstubAllGlobals()
})

describe('curator and vault type of a hidden vault', () => {
  it('shows K3 Capital and the governed type when eUSDC-42 is hidden because it is paused', async () => {
    setEusdc42Labels('config-suspended')
    const html = await render(makeEusdc42())

    expect(curatorCell(html)).toContain('data-test-curator="K3 Capital"')
    expect(curatorCell(html)).not.toContain('Flagged')
    expect(vaultTypeCell(html)).toContain('data-test-chip="governed"')
  })

  it.each(['consistency-suspended', 'consistency-revoked'])('blanks the curator and vault type for the governance verdict %s', async (decidedBy) => {
    setEusdc42Labels(decidedBy)
    const html = await render(makeEusdc42())

    expect(curatorCell(html)).toContain('Flagged')
    expect(curatorCell(html)).not.toContain('data-test-curator')
    expect(vaultTypeCell(html)).toContain('-')
    expect(vaultTypeCell(html)).not.toContain('data-test-chip')
  })

  it('blanks the curator of the Idle DAO credit vault, hidden by a governance rule inside config-failed', async () => {
    setLabels(
      { [IDLE_CREDIT_VAULT.toLowerCase()]: IDLE_CREDIT_VAULT_VERDICT },
      { [IDLE_CREDIT_VAULT.toLowerCase()]: assessmentEntry(IDLE_CREDIT_VAULT_RAW_ASSESSMENT) },
    )
    const html = await render(makeIdleCreditVault())

    expect(curatorCell(html)).toContain('Flagged')
    expect(curatorCell(html)).not.toContain('Idle DAO')
    expect(vaultTypeCell(html)).not.toContain('data-test-chip')
  })

  it('keeps the curator blank while the assessment has not loaded', async () => {
    setLabels({ [EUSDC_42.toLowerCase()]: liquityHubHiddenVerdict('config-suspended') })
    const html = await render(makeEusdc42())

    expect(curatorCell(html)).toContain('Flagged')
    expect(curatorCell(html)).not.toContain('data-test-curator')
  })
})

describe('Safe badge beside the curator', () => {
  it('names the curator without the Safe badge, which belongs to the Addresses rows', async () => {
    setEusdc42Labels('config-suspended')
    const html = await render(makeEusdc42())

    expect(curatorCell(html)).toContain('data-test-curator="K3 Capital"')
    expect(html).not.toContain('data-test-safe')
  })
})
