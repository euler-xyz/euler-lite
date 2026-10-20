import { describe, expect, it, vi } from 'vitest'
import { resolveLabelLogo } from '~/utils/label-logo'
import { eulerLabelEntityEmpty, getEulerLabelEntityLogo, getEulerLabelPointLogo } from '~/entities/euler/labels'
import { normalizeLabelsBundle, type PublicEulerLabelsData } from '~/utils/public-labels'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'

const mocks = vi.hoisted(() => ({ data: undefined as PublicEulerLabelsData | undefined }))
vi.mock('~/composables/useEulerLabels', () => ({ getEulerLabelsSourceData: () => mocks.data }))

const IMAGES_BASE = 'https://images.fork.test/assets'

describe('label image hosts', () => {
  it.each([IMAGES_BASE, 'https://images.fork.test:8443/assets'])('uses the discovered public image base %s and accepts its canonical result', (base) => {
    const resolved = resolveLabelLogo('https://token-images.euler.finance/labels/kpk.svg', undefined, [], base)
    expect(resolved).toBe(`${base}/labels/kpk`)
    expect(resolveLabelLogo(resolved, undefined, [], base)).toBe(resolved)
  })
  it.each(['', undefined, 'http://images.fork.test/assets', 'https://user:secret@images.fork.test/assets'])('does not use a production fallback when the public image base is %s', (base) => {
    expect(resolveLabelLogo('https://token-images.euler.finance/labels/kpk', undefined, [], base)).toBe('')
  })
  it.each(['kpk', 'kpk.svg', 'kpk.PNG', 'kpk.webp?v=old#logo'])('maps the legacy label %s to its V3 image', (key) => {
    expect(resolveLabelLogo(`https://token-images.euler.finance/labels/${key}`, undefined, [], IMAGES_BASE)).toBe(`${IMAGES_BASE}/labels/kpk`)
  })
  it('preserves the label key and accepts the default HTTPS port', () => {
    expect(resolveLabelLogo('https://token-images.euler.finance:443/labels/K3_Capital-1.jpg', undefined, [], IMAGES_BASE)).toBe(`${IMAGES_BASE}/labels/K3_Capital-1`)
  })
  it.each([
    '/1/0x1234', '/sync/1', '/labels/', '/labels/nested/kpk',
    '/labels/kpk.html', '/labels/kpk.svg/extra', '/labels/kpk%2Fother',
  ])('rejects unsupported legacy paths even on a configured origin: %s', (path) => {
    const origin = 'https://token-images.euler.finance'
    expect(resolveLabelLogo(`${origin}${path}`, origin, [origin], IMAGES_BASE)).toBe('')
  })
  it.each(['usual', 'k3', 'clearstar'])('allows a V3 curator image for %s', (slug) => {
    const url = `https://v3.euler.finance/v3/images/labels/${slug}`
    expect(resolveLabelLogo(url)).toBe(url)
  })
  it.each([
    'https://token-images.euler.finance.evil.test/x',
    'https://evil.test/logo.svg',
    'http://token-images.euler.finance/x',
    'http://token-images.euler.finance/labels/kpk',
    'https://token-images.euler.finance:444/labels/kpk',
    'https://user:secret@token-images.euler.finance/labels/kpk',
    'https://user@token-images.euler.finance/x',
    'https://v3.euler.finance.evil.test/v3/images/labels/usual',
    'http://v3.euler.finance/v3/images/labels/usual',
    'https://user@v3.euler.finance/v3/images/labels/usual',
    'https://v3.euler.finance/v3/images/other/usual',
    'https://v3.euler.finance/v3/images/labels/../other',
    'https://v3.euler.finance/v3/images/labels/usual?variant=other',
    '//evil.test/x',
    'data:image/svg+xml,x',
  ])('rejects %s', (url) => {
    expect(resolveLabelLogo(url)).toBe('')
  })
  it('allows static filenames and URLs only on the configured source origin', () => {
    expect(resolveLabelLogo('fork.svg', 'https://fork.test/labels')).toBe('https://fork.test/labels/logo/fork.svg')
    expect(resolveLabelLogo('https://fork.test/labels/logo/fork.svg', 'https://fork.test/labels')).toBe('https://fork.test/labels/logo/fork.svg')
    expect(resolveLabelLogo('../secret', 'https://fork.test/labels')).toBe('')
    expect(resolveLabelLogo('https://elsewhere.test/x', 'https://fork.test/labels')).toBe('')
  })
  it('allows explicitly trusted origins without accepting lookalikes, credentials or other schemes', () => {
    const origins = ['https://images.fork.test', 'http://localhost:8080']
    expect(resolveLabelLogo('https://images.fork.test/labels/curator.svg', undefined, origins)).toBe('https://images.fork.test/labels/curator.svg')
    expect(resolveLabelLogo('http://localhost:8080/labels/curator.png', undefined, origins)).toBe('http://localhost:8080/labels/curator.png')
    for (const url of ['https://images.fork.test.evil.test/x', 'https://user:secret@images.fork.test/x', 'http://images.fork.test/x', 'data:image/png,x']) {
      expect(resolveLabelLogo(url, undefined, origins)).toBe('')
    }
    expect(resolveLabelLogo('https://images.fork.test/x')).toBe('')
  })
  it.each(['v3', 'v3-metadata'] as const)('renders approved %s entity and campaign logos through the browser helpers', (source) => {
    const labels = structuredClone(publicLabelsFixture)
    labels.entities[0].logo = 'https://images.fork.test/curator.svg'
    labels.vaults[0].campaigns![0].logo = 'https://images.fork.test/points.svg'
    const bundle = { source, labelSet: 'public', version: 'test', sourceFetchedAt: Date.now(), publicLabels: labels, logoOrigins: ['https://images.fork.test'] }
    mocks.data = normalizeLabelsBundle(1, bundle)
    expect(getEulerLabelEntityLogo(mocks.data.entities.kpk.logo)).toBe(labels.entities[0].logo)
    expect(getEulerLabelPointLogo(mocks.data.points[KPK_VAULT][0].logo)).toBe(labels.vaults[0].campaigns![0].logo)
    expect(getEulerLabelEntityLogo('https://images.fork.test.evil.test/x')).toBe('')
    expect(getEulerLabelEntityLogo('https://user:secret@images.fork.test/x')).toBe('')
  })
  it.each(['v3', 'v3-metadata'] as const)('resolves legacy %s entity and campaign images through the browser helpers', (source) => {
    mocks.data = normalizeLabelsBundle(1, {
      source, labelSet: 'public', version: 'test', sourceFetchedAt: Date.now(), publicLabels: publicLabelsFixture, imagesBaseUrl: IMAGES_BASE,
    })
    expect(getEulerLabelEntityLogo(mocks.data.entities.kpk.logo)).toBe(`${IMAGES_BASE}/labels/kpk`)
    expect(getEulerLabelPointLogo(mocks.data.points[KPK_VAULT][0].logo)).toBe(`${IMAGES_BASE}/labels/kpk`)
  })
  it('uses the discovered base for static legacy labels and keeps the normalized URL renderable', () => {
    mocks.data = normalizeLabelsBundle(1, {
      source: 'static', version: 'test', fetchedAt: Date.now(), logoBaseUrl: 'https://static.fork.test', imagesBaseUrl: IMAGES_BASE,
      files: { products: {}, entities: { curator: { ...eulerLabelEntityEmpty, logo: 'https://token-images.euler.finance/labels/kpk.svg' } }, points: [], earnVaults: [], assets: [] },
    })
    expect(mocks.data.entities.curator.logo).toBe(`${IMAGES_BASE}/labels/kpk`)
    expect(getEulerLabelEntityLogo(mocks.data.entities.curator.logo)).toBe(`${IMAGES_BASE}/labels/kpk`)
  })
  it('does not send legacy labels to production without a discovered image base', () => {
    mocks.data = normalizeLabelsBundle(1, {
      source: 'v3-metadata', labelSet: 'public', version: 'test', sourceFetchedAt: Date.now(), publicLabels: publicLabelsFixture, imagesBaseUrl: '',
    })
    expect(getEulerLabelEntityLogo(mocks.data.entities.kpk.logo)).toBe('')
    expect(getEulerLabelPointLogo(mocks.data.points[KPK_VAULT][0].logo)).toBe('')
  })
  it('keeps static image policy independent of hosted origin approvals', () => {
    const bundle = {
      source: 'static' as const, version: 'test', fetchedAt: Date.now(), logoBaseUrl: 'https://static.fork.test',
      files: { products: {}, entities: {}, points: [], earnVaults: [], assets: [] },
      logoOrigins: ['https://images.fork.test'],
    }
    mocks.data = normalizeLabelsBundle(1, bundle)
    expect(getEulerLabelEntityLogo('curator.svg')).toBe('https://static.fork.test/logo/curator.svg')
    expect(getEulerLabelEntityLogo('https://images.fork.test/curator.svg')).toBe('')
  })
})
