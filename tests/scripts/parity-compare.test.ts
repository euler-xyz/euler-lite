import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareSnapshots, PARITY_RENAMES, scrapePage } from '../../scripts/parity-compare.mjs'

// Supply rendered text to the actual browser scraper without launching the parity CLI.
function capture(text: string, field = 'curator', value?: string, id = 'data-point') {
  const attrs: Record<string, string> = { 'data-id': id, 'data-field': field }
  if (value !== undefined) attrs['data-value'] = value
  const element = {
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    innerText: text,
    tagName: 'DIV',
    getAttribute: (name: string) => attrs[name],
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
  }
  vi.stubGlobal('document', { title: 'Parity fixture', querySelectorAll: () => [element] })
  vi.stubGlobal('window', {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    location: { href: 'https://example.test/explore', pathname: '/explore', search: '' },
  })
  return scrapePage({ pageId: 'fixture', scenarioId: 'fixture', renames: PARITY_RENAMES })
}

afterEach(() => vi.unstubAllGlobals())

describe('parity data-point labels', () => {
  it.each([
    ['Risk manager', 'risk-manager'],
    ['Capital allocator', 'capital-allocator'],
    ['Curator', 'curator'],
  ])('compares %s and value-only captures equally', (label, field) => {
    const baseline = capture(`${label}\nGauntlet`, field)
    const candidate = capture('Gauntlet')

    expect(baseline.elements[0]).toMatchObject({
      field: 'curator', text: 'Gauntlet', compareValue: 'Gauntlet',
      attrs: { 'parity-derived-value': 'true' },
    })
    expect(compareSnapshots(baseline, candidate).status).toBe('pass')
  })

  it('compares old and current headings equally', () => {
    expect(compareSnapshots(
      capture('Risk manager\nGauntlet', 'risk-manager'),
      capture('Curator\nGauntlet'),
    ).status).toBe('pass')
  })

  it('strips headings from text even when an explicit value is present', () => {
    const baseline = capture('Risk manager\nGauntlet', 'risk-manager', 'Gauntlet')
    const candidate = capture('Gauntlet', 'curator', 'Gauntlet')

    expect(baseline.elements[0]).toMatchObject({ text: 'Gauntlet', compareValue: 'Gauntlet' })
    expect(baseline.elements[0].attrs).not.toHaveProperty('parity-derived-value')
    expect(compareSnapshots(baseline, candidate).status).toBe('pass')
  })

  it('still reports different fallback values', () => {
    expect(compareSnapshots(
      capture('Risk manager\nGauntlet', 'risk-manager'),
      capture('Steakhouse'),
    ).summary.valueMismatches).toBe(1)
  })

  it('preserves explicit values and detects their differences', () => {
    const baseline = capture('Risk manager\nGauntlet', 'risk-manager', 'entity-a')
    const candidate = capture('Curator\nGauntlet', 'curator', 'entity-b')

    expect(baseline.elements[0].compareValue).toBe('entity-a')
    expect(compareSnapshots(baseline, candidate).summary.valueMismatches).toBe(1)
  })

  it.each(['Curator Labs', 'Risk manager Capital', 'Curator', 'Another heading\nGauntlet'])(
    'preserves a value without a matching separate heading: %s', (text) => {
      expect(capture(text).elements[0]).toMatchObject({ text, compareValue: text })
    },
  )

  it('retains every value line and tolerates blank lines around the heading', () => {
    expect(capture(' \n Risk manager \n\n Gauntlet \n Steakhouse ', 'risk-manager').elements[0])
      .toMatchObject({ text: 'Gauntlet\nSteakhouse', compareValue: 'Gauntlet\nSteakhouse' })
  })

  it('keeps ordinary data-point heading extraction', () => {
    expect(compareSnapshots(capture('Supply APY\n5%', 'Supply APY'), capture('5%', 'Supply APY')).status)
      .toBe('pass')
  })

  it('keeps vault-header text handling separate', () => {
    expect(capture('Curator\nGauntlet\nCopy vault link', 'curator', undefined, 'vault-header').elements[0].text)
      .toBe('Curator\nGauntlet')
  })
})
