import { describe, expect, it } from 'vitest'
import { resolveLabelLogo } from '~/utils/label-logo'

describe('label image hosts', () => {
  it('allows the dedicated HTTPS host', () => {
    expect(resolveLabelLogo('https://token-images.euler.finance/labels/kpk')).toBe('https://token-images.euler.finance/labels/kpk')
  })
  it.each(['https://token-images.euler.finance.evil.test/x', 'https://evil.test/logo.svg', 'http://token-images.euler.finance/x', 'https://user@token-images.euler.finance/x', '//evil.test/x', 'data:image/svg+xml,x'])('rejects %s', (url) => {
    expect(resolveLabelLogo(url)).toBe('')
  })
  it('allows static filenames and URLs only on the configured source origin', () => {
    expect(resolveLabelLogo('fork.svg', 'https://fork.test/labels')).toBe('https://fork.test/labels/logo/fork.svg')
    expect(resolveLabelLogo('https://fork.test/labels/logo/fork.svg', 'https://fork.test/labels')).toBe('https://fork.test/labels/logo/fork.svg')
    expect(resolveLabelLogo('../secret', 'https://fork.test/labels')).toBe('')
    expect(resolveLabelLogo('https://elsewhere.test/x', 'https://fork.test/labels')).toBe('')
  })
})
