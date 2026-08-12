/**
 * Regression tests for the labels proxy's `validateNode` sanitizer.
 *
 * The proxy fetches curated-but-external JSON (products/entities/earn/points/assets)
 * and streams it to the browser. `validateNode` is the trust boundary: it rejects
 * payloads that would either (a) escape the intended rendering context in the UI
 * or (b) cause a client-side DoS. These tests lock in the specific defenses so a
 * future edit can't silently weaken them.
 *
 * If an assertion here starts failing, do not relax it before reviewing the
 * threat model in `docs/geo-blocking.md` and the PR that introduced the
 * corresponding defense (see git history for server/utils/labels-source.ts).
 */
import { describe, it, expect } from 'vitest'
import { projectEffectiveLabelsSource, validateNode } from '~/server/utils/labels-source'

describe('effective labels policy projection', () => {
  it('strips all legacy display content from the browser-facing overlay', () => {
    const address = '0x0000000000000000000000000000000000000001'
    const result = projectEffectiveLabelsSource({
      product: {
        name: 'Legacy name',
        description: 'Legacy description',
        entity: 'legacy-entity',
        tags: ['legacy-tag'],
        vaults: [address],
        block: ['US'],
        vaultOverrides: {
          [address]: {
            name: 'Legacy vault name',
            restricted: ['CA'],
          },
        },
      },
    }, [{
      address,
      description: 'Legacy Earn description',
      notExplorable: true,
    }], [{
      address,
      name: 'Legacy asset name',
      block: ['US'],
    }])

    expect(result).toEqual({
      products: {
        product: {
          vaults: [address],
          block: ['US'],
          vaultOverrides: {
            [address]: { restricted: ['CA'] },
          },
        },
      },
      earnVaults: [{ address, notExplorable: true }],
      assets: [{ address, block: ['US'] }],
    })
    expect(JSON.stringify(result)).not.toContain('Legacy')
  })
})

describe('validateNode — size caps', () => {
  it('rejects strings longer than 16 KiB (client-side DoS guard)', () => {
    const oversize = 'a'.repeat(16_385)
    expect(() => validateNode({ name: oversize }, 'root')).toThrow(/String too long/)
  })

  it('accepts strings exactly at the 16 KiB limit', () => {
    const atLimit = 'a'.repeat(16_384)
    expect(() => validateNode({ name: atLimit }, 'root')).not.toThrow()
  })

  it('rejects arrays larger than 10 000 entries', () => {
    const oversize = new Array(10_001).fill({})
    expect(() => validateNode(oversize, 'root')).toThrow(/Array too large/)
  })

  it('accepts arrays exactly at the 10 000-entry limit', () => {
    const atLimit = new Array(10_000).fill({})
    expect(() => validateNode(atLimit, 'root')).not.toThrow()
  })

  it('walks nested arrays and rejects oversize strings inside them', () => {
    const oversize = 'a'.repeat(16_385)
    const payload = [{ nested: { description: oversize } }]
    expect(() => validateNode(payload, 'root')).toThrow(/String too long/)
  })
})

describe('validateNode — logo filename allowlist', () => {
  // Logo values are concatenated into `${CDN}/${logo}` and `/entities/${logo}`
  // in several components. A slip through here means the browser can be
  // pointed off-origin or into a different asset directory.
  const ACCEPTED = [
    'foo.svg',
    'foo.png',
    'foo.jpg',
    'foo.jpeg',
    'foo.webp',
    'foo.gif',
    'FOO.SVG', // case-insensitive extension
    'abc_123-XYZ.png',
  ]

  const REJECTED = [
    '../secret.svg', // path traversal
    'sub/dir/foo.svg', // nested path
    '/abs.svg', // absolute path
    '//evil.example/foo.svg', // protocol-relative URL
    'http://evil.example/foo.svg', // absolute URL
    'javascript:alert(1)', // scheme
    'foo.svg?x=1', // query string
    'foo.svg#frag', // fragment
    'foo', // no extension
    'foo.exe', // non-image extension
    'foo..svg', // double-dot sneak
    'foo bar.svg', // space (not in [a-zA-Z0-9_-])
  ]

  it.each(ACCEPTED)('accepts %s as a logo value', (value) => {
    expect(() => validateNode({ logo: value }, 'root')).not.toThrow()
  })

  it.each(REJECTED)('rejects %s as a logo value', (value) => {
    expect(() => validateNode({ logo: value }, 'root')).toThrow(/Unsafe logo filename/)
  })

  it('accepts an empty logo value (opt-out sentinel)', () => {
    expect(() => validateNode({ logo: '' }, 'root')).not.toThrow()
  })

  it('ignores the allowlist for keys other than `logo`', () => {
    // Only `logo` is known to be concatenated into an image URL; the
    // allowlist must not spuriously reject legitimate strings elsewhere.
    expect(() => validateNode({ description: '../secret.svg' }, 'root')).not.toThrow()
  })
})

describe('validateNode — URL scheme allowlist', () => {
  // `url` is bound directly to :href in Vue templates; non-http(s) schemes
  // allow `javascript:` / `data:` exfiltration on click.
  const ACCEPTED = [
    '',
    'http://example.com',
    'https://example.com/path?x=1',
  ]

  const REJECTED = [
    'javascript:alert(1)',
    'data:text/html,<script>',
    'file:///etc/passwd',
    'ftp://example.com',
    'not a url',
  ]

  it.each(ACCEPTED)('accepts url=%s', (value) => {
    expect(() => validateNode({ url: value }, 'root')).not.toThrow()
  })

  it.each(REJECTED)('rejects url=%s', (value) => {
    expect(() => validateNode({ url: value }, 'root')).toThrow(/Unsafe URL/)
  })
})

describe('validateNode — regex field caps + compilability', () => {
  // assets.json pattern rules carry raw regex source from upstream. An
  // invalid regex would crash at client load; an excessively long one is
  // a ReDoS foot-gun even with the runtime input cap.
  it('accepts simple patterns in symbolRegex', () => {
    expect(() => validateNode({ symbolRegex: '^USD.*$' }, 'root')).not.toThrow()
    expect(() => validateNode({ nameRegex: '^Ondo\\s' }, 'root')).not.toThrow()
  })

  it('rejects patterns longer than 512 chars', () => {
    const oversize = 'a'.repeat(513)
    expect(() => validateNode({ symbolRegex: oversize }, 'root')).toThrow(/Invalid regex/)
  })

  it('accepts patterns exactly at the 512-char limit', () => {
    const atLimit = 'a'.repeat(512)
    expect(() => validateNode({ symbolRegex: atLimit }, 'root')).not.toThrow()
  })

  it('rejects patterns that do not compile', () => {
    expect(() => validateNode({ symbolRegex: '*invalid(' }, 'root')).toThrow(/Invalid regex/)
  })

  it('ignores the compile check for keys other than symbolRegex / nameRegex', () => {
    expect(() => validateNode({ description: '*invalid(' }, 'root')).not.toThrow()
  })
})

describe('validateNode — markdown-link injection', () => {
  // `[text](https://..."...)` closes the href attribute and lets additional
  // HTML attributes be smuggled via HTML parser error recovery. Only the
  // href-injection shape matters; bare double-quotes in link text are fine.
  const INJECTION_FIELDS = ['description', 'deprecationReason', 'deprecateReason', 'portfolioNotice']

  it.each(INJECTION_FIELDS)('rejects the injection pattern in %s', (key) => {
    const payload = { [key]: 'see [here](https://x.com"onmouseover=alert(1))' }
    expect(() => validateNode(payload, 'root')).toThrow(/Injection pattern detected/)
  })

  it('accepts plain markdown links', () => {
    expect(() =>
      validateNode({ description: 'see [docs](https://docs.example.com)' }, 'root'),
    ).not.toThrow()
  })

  it('accepts double-quotes in link text (not an injection vector)', () => {
    expect(() =>
      validateNode({ description: 'see ["the docs"](https://docs.example.com)' }, 'root'),
    ).not.toThrow()
  })

  it('ignores the injection check for keys outside the link-text allowlist', () => {
    // `name`, `logo`, `url` etc. are not rendered through autoLink().
    expect(() =>
      validateNode({ name: 'see [here](https://x.com"onmouseover=alert(1))' }, 'root'),
    ).not.toThrow()
  })
})

describe('validateNode — traversal', () => {
  it('walks deeply nested object graphs', () => {
    const oversize = 'a'.repeat(16_385)
    const payload = { a: { b: { c: { d: { name: oversize } } } } }
    expect(() => validateNode(payload, 'root')).toThrow(/String too long/)
  })

  it('is a no-op for primitives at the top level', () => {
    expect(() => validateNode(null, 'root')).not.toThrow()
    expect(() => validateNode(undefined, 'root')).not.toThrow()
    expect(() => validateNode('bare string', 'root')).not.toThrow()
    expect(() => validateNode(42, 'root')).not.toThrow()
  })

  it('surfaces the offending path in the error message', () => {
    const oversize = 'a'.repeat(16_385)
    const payload = { outer: { inner: { description: oversize } } }
    expect(() => validateNode(payload, 'products.json')).toThrow(
      /products\.json\.outer\.inner\.description/,
    )
  })
})
