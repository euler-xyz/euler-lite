import { createSSRApp, defineComponent, h, ref, type Component, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { vi } from 'vitest'
import type { PublicEulerLabelsData } from '~/utils/public-labels'
import { __setEulerLabelsDataForTest, useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useVaults } from '~/composables/useVaults'

type AssessmentEntryStub = { status: string, verdictKey?: string }

export type CardLabels = {
  verdicts: Record<string, unknown>
  entries?: Record<string, AssessmentEntryStub>
  entities?: Record<string, unknown>
  products?: Record<string, unknown>
  managingEntityByVault?: Record<string, string>
  verifiedVaultAddresses?: string[]
}

export const ensureVaultAssessment = vi.fn()

export const setCardLabels = ({ verdicts, entries = {}, entities = {}, products = {}, managingEntityByVault = {}, verifiedVaultAddresses = [] }: CardLabels) => {
  __setEulerLabelsDataForTest({
    source: 'v3',
    entities,
    products,
    managingEntityByVault,
    verifiedVaultAddresses,
    visibility: verdicts,
  } as unknown as Partial<PublicEulerLabelsData>)
  vi.stubGlobal('useEulerLabels', () => ({
    ...useEulerLabels(),
    getVaultAssessmentEntry: (_chainId: number, address: string) => entries[address.toLowerCase()] ?? { status: 'idle' },
    ensureVaultAssessment,
  }))
}

const passthrough = defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) })
const empty = { render: () => null }

export const stubCardGlobals = () => {
  ensureVaultAssessment.mockReset()
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useChainConfig', () => ({ deprecatedChainIds: [], eVaultFetchChunkChainIds: [] }))
  vi.stubGlobal('useEulerSdk', () => ({ getEulerSdk: vi.fn(), getEulerSdkForChain: vi.fn() }))
  vi.stubGlobal('useEulerLabels', useEulerLabels)
  vi.stubGlobal('useVaultRegistry', useVaultRegistry)
  vi.stubGlobal('useVaults', useVaults)
  vi.stubGlobal('useWagmi', () => ({ isConnected: ref(false) }))
  vi.stubGlobal('useDeployConfig', () => ({ enableEntityBranding: true }))
  vi.stubGlobal('useRoute', () => ({ query: {} }))
  vi.stubGlobal('useWallets', () => ({ getBalance: () => 0n, isLoading: ref(false) }))
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false }) }))
  vi.stubGlobal('useApyVisibility', () => ({ viewer: ref(undefined) }))
  vi.stubGlobal('useTokenList', () => ({ getTokenCategoryTags: () => [], isLoaded: ref(false) }))
  vi.stubGlobal('useRewardsApy', () => ({
    getSupplyRewardApy: () => 0,
    getBorrowRewardApy: () => 0,
    getLoopingRewardApy: () => 0,
    hasSupplyRewards: () => false,
    hasBorrowRewards: () => false,
    hasLoopingRewards: () => false,
    getSupplyRewardCampaigns: () => [],
    getBorrowRewardCampaigns: () => [],
    getLoopingRewardCampaigns: () => [],
  }))
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
  vi.stubGlobal('getVaultSupplyApy', () => 0)
  vi.stubGlobal('getVaultBorrowApy', () => 0)
  vi.stubGlobal('ltvToPercent', () => 0)
}

export const renderCard = (component: Component, props: Record<string, unknown>) => {
  const app = createSSRApp({ render: () => h(component, props) })
  app.config.warnHandler = () => undefined
  Object.assign(app.config.globalProperties, { $route: { query: {} } })
  app.component('NuxtLink', passthrough)
  app.component('CuratorEntityLink', defineComponent({
    props: { entities: { type: Array as PropType<Array<{ name: string }>>, required: true }, label: String },
    setup: props => () => h('span', { 'data-test-curator': props.label ?? props.entities.map(entity => entity.name).join(',') }),
  }))
  app.component('VaultEntityDisclosureTooltip', defineComponent({
    props: { entities: { type: Array, required: true } },
    setup: (props, { slots }) => () => h('span', { 'data-test-disclosure': props.entities.length }, slots.default?.()),
  }))
  for (const name of [
    'AssetAvatar', 'VaultDisplayName', 'RecentlyAddedBadge', 'KeyringBadge', 'GovernanceLimitedBadge', 'CyclicalNoteBadge',
    'RestrictedBadge', 'VaultDeprecatedBadge', 'LiquidationCoverageBadge', 'VaultAssessmentWarning', 'VaultAssessmentWarningLines',
    'VaultAssessmentChecksField', 'VaultPoints', 'VaultWarningIcon', 'VaultExposureDisplay', 'VaultExposureSummary',
    'VaultNoUsdPriceHint', 'UiRadialProgress', 'SvgIcon', 'CorrelatedPairBadge',
  ]) {
    app.component(name, empty)
  }
  return renderToString(app)
}

export type CuratorState = 'unknown' | 'ungoverned' | `curator:${string}`

/** Curator cells in document order: the desktop cell renders before the mobile one. */
export const curatorStates = (html: string): CuratorState[] =>
  [...html.matchAll(/bg-error-100 text-error-500[^>]*>(?:(?!<\/div>)[\s\S])*Unknown|data-test-curator="([^"]*)"|>\s*Ungoverned\s*</g)]
    .map((match) => {
      if (match[1] !== undefined) return `curator:${match[1]}` as const
      return match[0].includes('Ungoverned') ? 'ungoverned' : 'unknown'
    })

export const disclosureCounts = (html: string): number[] =>
  [...html.matchAll(/data-test-disclosure="(\d+)"/g)].map(match => Number(match[1]))

export const ensuredAddresses = () =>
  ensureVaultAssessment.mock.calls.map(([, address]) => String(address).toLowerCase())
