import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EulerLabelEntity } from '~/entities/euler/labels'
import type { CuratorProfileData } from '~/utils/curator-profile'
import CuratorProfilePage from '~/pages/curators/[slug].vue'

vi.mock('~/entities/euler/labels', () => ({ getEulerLabelEntityLogo: () => '' }))
vi.mock('~/entities/chainRegistry', () => ({ getChainById: () => ({ name: 'Ethereum' }) }))
vi.mock('~/utils/chain-logo', () => ({ getChainLogoUrl: () => '' }))

const curator: EulerLabelEntity = {
  id: 'test-curator', name: 'Test Curator', logo: '', description: 'Curator description',
  url: 'https://curator.example', addresses: {},
  social: { twitter: '', youtube: '', discord: '', telegram: '', github: '' },
}

const renderProfile = async (
  data: CuratorProfileData | undefined,
  status: 'success' | 'pending' | 'error' = 'success',
  fallback: EulerLabelEntity = curator,
) => {
  vi.stubGlobal('useRoute', () => ({ params: { slug: curator.id }, query: { network: '1' }, hash: '' }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useWagmi', () => ({ changeChain: vi.fn() }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1), allowedChainIds: ref([1]) }))
  vi.stubGlobal('useEulerCuratorProfile', () => ({
    fallbackEntity: ref(fallback), managedMarkets: ref([]), earnVaults: ref([]),
    isUnavailable: ref(false), isLoading: ref(false),
  }))
  vi.stubGlobal('useFetch', (url: () => string) => url().includes('curator-profiles')
    ? { data: ref(data), status: ref(status), error: ref(status === 'error' ? new Error('Unavailable') : null), refresh: vi.fn() }
    : { data: ref({ networks: [] }), status: ref('success'), error: ref(null), refresh: vi.fn() })

  const app = createSSRApp(CuratorProfilePage)
  const stub = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
  for (const name of [
    'BackButton', 'BaseAvatar', 'UiHoverPreviewTooltip', 'UiProgress', 'UiIcon', 'UiTabs',
    'UiLoader', 'LabelsUnavailableState', 'UiEmptyState', 'UiButton', 'NuxtLink',
    'DiscoveryMarketAccordion', 'VaultEarnItem',
  ]) app.component(name, stub)
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('curator profile completeness display', () => {
  it('shows the published profile score and names every missing disclosure', async () => {
    const html = await renderProfile({ source: 'v3', entity: curator })
    expect(html).toContain('25% complete')
    expect(html).toContain('2 of 8 details provided')
    expect(html.match(/Not provided/g)).toHaveLength(6)
    expect(html).toContain('The curator has not shared its security practices.')
  })

  it('shows populated disclosures without missing-field messages', async () => {
    const html = await renderProfile({ source: 'v3', entity: {
      ...curator, legalEntityName: 'Example Ltd', riskMethodology: 'Risk policy', security: 'Security policy',
      termsOfService: 'Terms', licenses: 'Not applicable', disclaimers: 'None apply',
    } })
    expect(html).toContain('100% complete')
    expect(html).toContain('Security policy')
    expect(html).not.toContain('Not provided')
    expect(html).not.toContain('has not provided')
  })

  it.each(['static', 'error', 'pending'] as const)('does not score missing fields in a %s profile', async (state) => {
    const fallback = { ...curator, security: 'Available security details' }
    const data: CuratorProfileData | undefined = state === 'static'
      ? { source: 'static', entity: null }
      : state === 'pending' ? { source: 'v3', entity: fallback } : undefined
    const html = await renderProfile(data, state === 'static' ? 'success' : state, fallback)
    expect(html).toContain('Test Curator')
    expect(html).toContain('Available security details')
    expect(html).not.toContain('% complete')
    expect(html).not.toContain('Not provided')
    expect(html).not.toContain('has not provided')
  })

  it('does not carry a score across curator identity changes', async () => {
    const html = await renderProfile({ source: 'v3', entity: { ...curator, id: 'other-curator' } })
    expect(html).not.toContain('% complete')
    expect(html).not.toContain('Not provided')
  })
})
