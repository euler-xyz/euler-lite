import { describe, expect, it } from 'vitest'
import { resolveLabelLogo } from '~/utils/label-logo'

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
})
