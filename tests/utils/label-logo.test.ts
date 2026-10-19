import { describe, expect, it, vi } from 'vitest'
import { resolveLabelLogo } from '~/utils/label-logo'
import { getEulerLabelEntityLogo, getEulerLabelPointLogo } from '~/entities/euler/labels'
import { normalizeLabelsBundle, type PublicEulerLabelsData } from '~/utils/public-labels'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'

const mocks = vi.hoisted(() => ({ data: undefined as PublicEulerLabelsData | undefined }))
vi.mock('~/composables/useEulerLabels', () => ({ getEulerLabelsSourceData: () => mocks.data }))

describe('label image hosts', () => {
  it('allows the dedicated HTTPS host', () => {
    expect(resolveLabelLogo('https://token-images.euler.finance/labels/kpk')).toBe('https://token-images.euler.finance/labels/kpk')
  })
  it.each(['usual', 'k3', 'clearstar'])('allows a V3 curator image for %s', (slug) => {
    const url = `https://v3.euler.finance/v3/images/labels/${slug}`
    expect(resolveLabelLogo(url)).toBe(url)
  })
  it.each([
    'https://token-images.euler.finance.evil.test/x',
    'https://evil.test/logo.svg',
    'http://token-images.euler.finance/x',
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
