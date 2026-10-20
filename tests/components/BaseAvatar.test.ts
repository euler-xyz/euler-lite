import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLabelLogo } from '~/utils/label-logo'

const { imageState, loadImage } = vi.hoisted(() => {
  const imageState = { isReady: false, error: null as unknown }
  return { imageState, loadImage: vi.fn(() => imageState) }
})

vi.mock('@vueuse/core', () => ({
  useImage: loadImage,
}))

const { default: BaseAvatar } = await import('~/components/base/BaseAvatar.vue')

const INLINE_LOGO = 'data:image/svg+xml;base64,PHN2Zy8+'
const REMOTE_LOGO = 'https://images.example/v3/images/chains/8453'

const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(BaseAvatar, props) }))

describe('BaseAvatar', () => {
  beforeEach(() => {
    loadImage.mockClear()
    imageState.isReady = false
    imageState.error = null
  })

  it('requests the V3 label image and shows initials when it is unavailable', async () => {
    imageState.error = new Error('404 Not Found')
    const src = resolveLabelLogo('https://token-images.euler.finance/labels/missing-curator.svg', undefined, [], 'https://images.fork.test/assets')
    const html = await render({ src, label: 'Missing curator' })

    expect(loadImage).toHaveBeenCalledWith({
      src: 'https://images.fork.test/assets/labels/missing-curator',
      referrerPolicy: 'no-referrer',
    })
    expect(html).toContain('data-label="Mi"')
    expect(html).not.toContain('<img')
  })

  it('shows initials without making an image request when the public base is unavailable', async () => {
    const src = resolveLabelLogo('https://token-images.euler.finance/labels/kpk', undefined, [], '')
    const html = await render({ src, label: 'KPK' })
    expect(loadImage).not.toHaveBeenCalled()
    expect(html).toContain('data-label="KP"')
  })

  it('shows an inline fallback while the remote image is still loading', async () => {
    imageState.isReady = false
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: INLINE_LOGO, label: 'Base' })

    expect(html).toContain(`src="${INLINE_LOGO}"`)
    expect(html).not.toContain('data-label')
  })

  it('shows initials while loading when the fallback is not inline', async () => {
    imageState.isReady = false
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: 'https://other.example/logo.png', label: 'Base' })

    expect(html).toContain('data-label="Ba"')
    expect(html).not.toContain('<img')
  })

  it('shows the fallback straight away when there is no primary image', async () => {
    imageState.isReady = false
    const html = await render({ src: '', fallbackSrc: INLINE_LOGO, label: 'Base' })

    expect(html).toContain(`src="${INLINE_LOGO}"`)
  })

  it('shows the remote image once it has loaded', async () => {
    imageState.isReady = true
    const html = await render({ src: REMOTE_LOGO, fallbackSrc: INLINE_LOGO, label: 'Base' })

    expect(html).toContain(`src="${REMOTE_LOGO}"`)
  })
})
