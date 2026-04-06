import { describe, it, expect } from 'vitest'
import { autoLink } from '~/utils/autoLink'

// Helper: assert no <a> element carries an unescaped style attribute.
// If the href-injection attack works, the broken href closes early and
// the parser creates a second attribute like style="position:fixed;...".
const hasInjectedStyleAttr = (html: string) => /<a[^>]* style=/.test(html)

describe('autoLink — XSS injection prevention', () => {
  it('does not inject a style attribute when " terminates the URL (VULN-01/02 pattern)', () => {
    const input = '[XSS](https://euler.finance"style="color:#ffffff;background:#0000cc")'
    const result = autoLink(input)

    expect(hasInjectedStyleAttr(result)).toBe(false)
    // The CSS text must appear as HTML-encoded prose, not as an attribute
    expect(result).toContain('&quot;style=')
    // The href must be the truncated safe URL only
    expect(result).toContain('href="https://euler.finance"')
    expect(result).not.toContain('href="https://euler.finance"style=')
  })

  it('does not create a full-page overlay via portfolioNotice pattern (VULN-05)', () => {
    const input = '[CLICK-TO-VERIFY-WALLET](https://attacker.com"style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647")'
    const result = autoLink(input)

    expect(hasInjectedStyleAttr(result)).toBe(false)
    expect(result).toContain('&quot;style=')
    // attacker.com becomes a plain-URL link, not the anchor for the injected style
    expect(result).toContain('href="https://attacker.com"')
  })

  it('does not create a link for javascript: URLs in markdown syntax', () => {
    // LINK_RE requires https?:// so javascript: is never matched as a URL.
    // The full string is rendered as escaped plain text — no <a> element created.
    const result = autoLink('[click here](javascript:alert(document.origin))')
    expect(result).not.toContain('<a')
  })

  it('does not create a link for data: URLs in markdown syntax', () => {
    // Same — data: scheme is not matched; <script> tags in the text are escaped.
    const result = autoLink('[click](data:text/html,<script>alert(1)</script>)')
    expect(result).not.toContain('<a')
    expect(result).toContain('&lt;script&gt;')
  })

  it('does not create a link for plain javascript: text', () => {
    const result = autoLink('javascript:alert(1)')
    expect(result).not.toContain('<a')
  })

  it('escapes HTML tags injected via link text', () => {
    const result = autoLink('[<img src=x onerror=alert(1)>](https://euler.finance)')
    expect(result).not.toContain('<img')
    expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(result).toContain('href="https://euler.finance"')
  })

  it('escapes " in link text so it cannot close the href attribute', () => {
    const result = autoLink('["The Core" Vault](https://euler.finance)')
    expect(result).toContain('&quot;The Core&quot; Vault')
    // The href must be properly closed — no attribute injection possible
    expect(result).toContain('href="https://euler.finance"')
    expect(hasInjectedStyleAttr(result)).toBe(false)
  })

  it('treats percent-encoded %22 in URL as a URL character, not an attribute-closing quote', () => {
    // %22 is the percent-encoding of " — it must stay in the href as-is and not
    // become an HTML attribute boundary when the browser parses the HTML.
    const result = autoLink('[x](https://evil.com%22style%3Dcolor:red)')
    expect(result).toContain('href="https://evil.com%22style%3Dcolor:red"')
    expect(hasInjectedStyleAttr(result)).toBe(false)
  })
})

describe('autoLink — correct link rendering', () => {
  it('renders a valid markdown link', () => {
    const result = autoLink('[Euler Finance](https://euler.finance)')
    expect(result).toBe(
      '<a href="https://euler.finance" target="_blank" rel="noopener noreferrer">Euler Finance</a>',
    )
  })

  it('renders a plain URL as a link', () => {
    const result = autoLink('https://euler.finance')
    expect(result).toBe(
      '<a href="https://euler.finance" target="_blank" rel="noopener noreferrer">https://euler.finance</a>',
    )
  })

  it('all links carry target="_blank" and rel="noopener noreferrer"', () => {
    const md = autoLink('[a](https://euler.finance)')
    expect(md).toContain('target="_blank"')
    expect(md).toContain('rel="noopener noreferrer"')

    const plain = autoLink('https://euler.finance')
    expect(plain).toContain('target="_blank"')
    expect(plain).toContain('rel="noopener noreferrer"')
  })

  it('renders multiple links in the same string', () => {
    const result = autoLink('[docs](https://docs.euler.finance) and [app](https://euler.finance)')
    expect(result).toContain('href="https://docs.euler.finance"')
    expect(result).toContain('href="https://euler.finance"')
    expect(result).toContain('>docs<')
    expect(result).toContain('>app<')
  })

  it('renders surrounding plain text unchanged around links', () => {
    const result = autoLink('Visit [euler](https://euler.finance) today')
    expect(result).toMatch(/^Visit /)
    expect(result).toMatch(/ today$/)
  })
})

describe('autoLink — URL encoding', () => {
  it('encodes & in markdown link URLs as &amp;', () => {
    const result = autoLink('[link](https://euler.finance?a=1&b=2)')
    expect(result).toContain('href="https://euler.finance?a=1&amp;b=2"')
    // Must not contain a raw & in the href attribute value
    expect(result).not.toContain('href="https://euler.finance?a=1&b=2"')
  })

  it('encodes & in plain URLs as &amp;', () => {
    const result = autoLink('https://euler.finance?a=1&b=2')
    expect(result).toContain('href="https://euler.finance?a=1&amp;b=2"')
  })
})

describe('autoLink — HTML escaping in surrounding text', () => {
  it('escapes < > & " in plain text', () => {
    const result = autoLink('Earn <10% APY & "guaranteed" yields > zero')
    expect(result).not.toContain('<10%')
    expect(result).toContain('&lt;10%')
    expect(result).toContain('&amp;')
    expect(result).toContain('&quot;guaranteed&quot;')
    expect(result).toContain('&gt; zero')
  })
})

describe('autoLink — markdown rendering', () => {
  it('converts **text** to <strong>', () => {
    const result = autoLink('**important** notice')
    expect(result).toBe('<strong>important</strong> notice')
  })

  it('converts \\n to <br>', () => {
    const result = autoLink('line one\nline two')
    expect(result).toBe('line one<br>line two')
  })

  it('converts \\r\\n to <br>', () => {
    const result = autoLink('line one\r\nline two')
    expect(result).toBe('line one<br>line two')
  })

  it('returns empty string for empty input', () => {
    expect(autoLink('')).toBe('')
  })

  it('returns plain text unchanged when no links or markdown', () => {
    expect(autoLink('no links here')).toBe('no links here')
  })
})
