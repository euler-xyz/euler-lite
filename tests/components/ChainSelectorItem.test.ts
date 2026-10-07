import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageState = { isReady: false, error: null as unknown }

vi.mock('@vueuse/core', () => ({
  useImage: () => imageState,
}))

const { default: BaseAvatar } = await import('~/components/base/BaseAvatar.vue')
const { default: ChainSelectorItem } = await import('~/components/entities/chains/ChainSelectorItem.vue')

const render = () => {
  vi.stubGlobal('useEnvConfig', () => ({ v3ImagesUrl: 'https://images.example' }))
  const app = createSSRApp({ render: () => h(ChainSelectorItem, { chainId: 8453, name: 'Base' }) })
  app.component('BaseAvatar', BaseAvatar)
  return renderToString(app)
}

describe('ChainSelectorItem', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the chain logo only from the V3 images host', async () => {
    imageState.isReady = true
    const html = await render()

    expect(html).toContain('src="https://images.example/v3/images/chains/8453"')
    expect(html).not.toContain('data:image')
  })

  it('shows the chain initials until the V3 logo loads, with no bundled image', async () => {
    imageState.isReady = false
    const html = await render()

    expect(html).toContain('data-label="Ba"')
    expect(html).not.toContain('<img')
  })
})
