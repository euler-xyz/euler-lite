import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageState = { isReady: false, error: null as unknown }

const { BUNDLED_LOGO_CHAIN_ID, BUNDLED_LOGO_SRC } = vi.hoisted(() => ({
  BUNDLED_LOGO_CHAIN_ID: 424242,
  BUNDLED_LOGO_SRC: 'data:image/webp;base64,UklGRg==',
}))

vi.mock('@vueuse/core', () => ({
  useImage: () => imageState,
}))

vi.mock('~/utils/chain-logo', () => ({
  getChainLogoUrl: (chainId: number) => (chainId === BUNDLED_LOGO_CHAIN_ID ? BUNDLED_LOGO_SRC : ''),
}))

const { default: BaseAvatar } = await import('~/components/base/BaseAvatar.vue')
const { default: ChainSelectorItem } = await import('~/components/entities/chains/ChainSelectorItem.vue')

const BASE = 'https://v3.example/v3/images'
const NO_LOGO_CHAIN_ID = 434343

const render = (props: { chainId: number, name: string }, v3ImagesUrl = BASE) => {
  vi.stubGlobal('useEnvConfig', () => ({ v3ImagesUrl }))
  const app = createSSRApp({ render: () => h(ChainSelectorItem, props) })
  app.component('BaseAvatar', BaseAvatar)
  return renderToString(app)
}

describe('ChainSelectorItem', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the V3 chain logo once it has loaded', async () => {
    imageState.isReady = true
    const html = await render({ chainId: BUNDLED_LOGO_CHAIN_ID, name: 'Forknet' })

    expect(html).toContain(`src="${BASE}/chains/${BUNDLED_LOGO_CHAIN_ID}"`)
  })

  it('shows the bundled chain logo while the V3 logo loads', async () => {
    imageState.isReady = false
    const html = await render({ chainId: BUNDLED_LOGO_CHAIN_ID, name: 'Forknet' })

    expect(html).toContain(`src="${BUNDLED_LOGO_SRC}"`)
    expect(html).not.toContain('data-label')
  })

  it('goes straight to the bundled logo when the images base is unknown', async () => {
    imageState.isReady = false
    const html = await render({ chainId: BUNDLED_LOGO_CHAIN_ID, name: 'Forknet' }, '')

    expect(html).toContain(`src="${BUNDLED_LOGO_SRC}"`)
    expect(html).not.toContain(`/chains/${BUNDLED_LOGO_CHAIN_ID}`)
  })

  it('shows the chain initials for a chain with no bundled logo', async () => {
    imageState.isReady = false
    const html = await render({ chainId: NO_LOGO_CHAIN_ID, name: 'Forknet' })

    expect(html).toContain('data-label="Fo"')
    expect(html).not.toContain('<img')
  })

  it('shows the chain initials when the V3 logo fails and there is no bundled logo', async () => {
    imageState.isReady = false
    imageState.error = new Event('error')
    try {
      const html = await render({ chainId: NO_LOGO_CHAIN_ID, name: 'Forknet' })

      expect(html).toContain('data-label="Fo"')
      expect(html).not.toContain('<img')
    }
    finally {
      imageState.error = null
    }
  })
})
