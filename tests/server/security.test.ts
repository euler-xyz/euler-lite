/**
 * Regression tests for clickjacking / iframe-embedding defenses.
 *
 * These are pure-function tests — they do not boot Nitro. They lock in
 * the directives and headers that must never silently regress. If a
 * future edit removes `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
 * the COOP header, or the frame-busting script, one of these tests will
 * fail loud.
 *
 * If you find yourself weakening an assertion here because a header /
 * directive is "no longer needed," stop and review the threat model in
 * docs/architecture.md (Clickjacking & Framing Defenses) first.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { H3Event } from 'h3'
import cspPlugin, { buildCsp, cspConnectOrigin, parseExtraConnectSrc } from '~/server/plugins/csp'
import { applySecurityHeaders } from '~/server/middleware/security-headers'
import { ANTI_CLICKJACK_SCRIPT } from '~/server/plugins/00-anti-clickjack'
import { escapeScriptJson } from '~/server/plugins/app-config'

const collectTsFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry)
  return statSync(path).isDirectory() ? collectTsFiles(path) : path.endsWith('.ts') ? [path] : []
})

describe('buildCsp', () => {
  const csp = buildCsp('test-nonce', [], { connect: [] }, [])

  it('forbids all frame ancestors', () => {
    expect(csp).toContain('frame-ancestors \'none\'')
  })

  it('embeds the per-request script nonce', () => {
    expect(csp).toContain('\'nonce-test-nonce\'')
  })

  it('disallows <object>/<embed> entirely', () => {
    expect(csp).toContain('object-src \'none\'')
  })

  it('never allows unsafe-inline in script-src', () => {
    // Extract the script-src directive to avoid false positives from
    // style-src which legitimately uses 'unsafe-inline'.
    const scriptSrc = csp
      .split(';')
      .map(d => d.trim())
      .find(d => d.startsWith('script-src'))
    expect(scriptSrc, 'script-src directive must be present').toBeDefined()
    expect(scriptSrc).not.toContain('\'unsafe-inline\'')
  })

  it('keeps strict-dynamic in script-src', () => {
    // strict-dynamic is what allows our nonce-bearing bootstrap to load
    // further scripts without explicit origin allowlists — losing it
    // would break the SPA under CSP.
    const scriptSrc = csp
      .split(';')
      .map(d => d.trim())
      .find(d => d.startsWith('script-src'))
    expect(scriptSrc).toContain('\'strict-dynamic\'')
  })

  it('locks base-uri to self (prevents base-tag hijack)', () => {
    expect(csp).toContain('base-uri \'self\'')
  })

  it('allows SDK error signature decoding via Sourcify 4byte API', () => {
    const connectSrc = csp
      .split(';')
      .map(d => d.trim())
      .find(d => d.startsWith('connect-src'))
    expect(connectSrc).toContain('https://api.4byte.sourcify.dev')
  })
})

describe('applySecurityHeaders', () => {
  function createMockEvent() {
    const headers: Record<string, string> = {}
    return {
      event: {
        node: {
          req: {},
          res: {
            setHeader: (name: string, value: string) => {
              headers[name] = value
            },
          },
        },
      } as unknown as H3Event,
      headers,
    }
  }

  it('sets X-Frame-Options: DENY (legacy clickjacking header)', () => {
    const { event, headers } = createMockEvent()
    applySecurityHeaders(event)
    expect(headers['X-Frame-Options']).toBe('DENY')
  })

  it('sets Cross-Origin-Opener-Policy allowing wallet popups', () => {
    const { event, headers } = createMockEvent()
    applySecurityHeaders(event)
    // `same-origin-allow-popups` is the strictest value that does not
    // break Reown AppKit / Coinbase Wallet popup-based connect flows.
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups')
  })

  it('sets X-Content-Type-Options: nosniff', () => {
    const { event, headers } = createMockEvent()
    applySecurityHeaders(event)
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('sets a referrer policy that does not leak cross-origin paths', () => {
    const { event, headers } = createMockEvent()
    applySecurityHeaders(event)
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })

  it('restricts browser features the app does not use', () => {
    const { event, headers } = createMockEvent()
    applySecurityHeaders(event)
    expect(headers['Permissions-Policy']).toContain('geolocation=()')
    expect(headers['Permissions-Policy']).toContain('microphone=()')
    expect(headers['Permissions-Policy']).toContain('camera=()')
  })
})

describe('ANTI_CLICKJACK_SCRIPT', () => {
  it('is a <script> tag', () => {
    expect(ANTI_CLICKJACK_SCRIPT.startsWith('<script>')).toBe(true)
    expect(ANTI_CLICKJACK_SCRIPT.endsWith('</script>')).toBe(true)
  })

  it('compares window.self against window.top', () => {
    // The core frame detection — if this is removed the whole defense
    // is a no-op.
    expect(ANTI_CLICKJACK_SCRIPT).toContain('window.self')
    expect(ANTI_CLICKJACK_SCRIPT).toContain('window.top')
  })

  it('hides the document root when framed', () => {
    expect(ANTI_CLICKJACK_SCRIPT).toContain('display')
    expect(ANTI_CLICKJACK_SCRIPT).toContain('none')
  })

  it('attempts to break out by navigating window.top', () => {
    expect(ANTI_CLICKJACK_SCRIPT).toContain('window.top.location')
  })

  it('contains no template literals (guards against accidental syntax breaks when inlined into HTML)', () => {
    // A stray backtick would be a common bug if someone refactors this
    // to use template strings — escaping inside HTML `<script>` gets
    // tricky fast. Keep it as a plain single-quoted string literal.
    expect(ANTI_CLICKJACK_SCRIPT).not.toContain('`')
  })
})

describe('escapeScriptJson (inline __APP_CONFIG__ payload)', () => {
  it('escapes `<` so a value cannot close the inline <script> tag', () => {
    const payload = JSON.stringify({ appTitle: '</script><script>alert(1)</script>' })
    const escaped = escapeScriptJson(payload)
    const scriptTag = `<script>window.__APP_CONFIG__=${escaped}</script>`

    // The only `</script>` in the emitted tag must be the closing one we added.
    expect(escaped).not.toContain('</script>')
    expect(escaped).not.toContain('<')
    expect(scriptTag.match(/<\/script>/g)).toHaveLength(1)
  })

  it('escapes U+2028 / U+2029 line separators (invalid in JS string literals)', () => {
    const escaped = escapeScriptJson(JSON.stringify({ appTitle: 'a b c' }))
    expect(escaped).toContain('\\u2028')
    expect(escaped).toContain('\\u2029')
    expect(escaped).not.toContain(' ')
    expect(escaped).not.toContain(' ')
  })

  it('preserves JSON/JS semantics — escaped payload parses back to the original', () => {
    const original = { appTitle: 'a < b </script>', appDescription: 'x y z' }
    const escaped = escapeScriptJson(JSON.stringify(original))
    // The unicode escapes are interpreted by the JS/JSON parser, yielding
    // the original characters back inside the string values.
    expect(JSON.parse(escaped)).toEqual(original)
  })
})

describe('server logging and inline-config invariants', () => {
  it('does not bypass the redacting server logger with console calls', () => {
    const offenders = collectTsFiles(join(process.cwd(), 'server')).flatMap(file =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
        /(?<![\w.])console\.(?:log|warn|error|info|debug|trace)\s*\(/.test(line)
          ? [`${file}:${index + 1}`]
          : [],
      ),
    )
    expect(offenders).toEqual([])
  })

  it('script-escapes every inline window config injection', () => {
    for (const file of ['server/plugins/app-config.ts', 'server/plugins/chain-config.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).toContain('escapeScriptJson(')
    }
  })
})

const directive = (csp: string, name: string) => csp.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `))
const sources = (csp: string, name: string) => directive(csp, name)?.split(' ').slice(1) ?? []

describe('the script and frame policy against an injected third-party script', () => {
  const csp = buildCsp('n0nce', [], { connect: [] }, [])

  it('runs only nonce-bearing scripts and what they load: no inline, no eval, no other origin', () => {
    expect(sources(csp, 'script-src')).toEqual([
      '\'self\'',
      '\'nonce-n0nce\'',
      '\'strict-dynamic\'',
    ])
    expect(sources(csp, 'script-src')).not.toContain('\'unsafe-inline\'')
    expect(sources(csp, 'script-src')).not.toContain('\'unsafe-eval\'')
    expect(sources(csp, 'script-src')).not.toContain('\'wasm-unsafe-eval\'')
  })

  it('lets a deployment widen connect-src only, never script-src, and only with encrypted origins', () => {
    const widened = buildCsp('n0nce', ['https://extra.example'], { connect: ['https://swap.example'] }, ['https://rpc.example'])
    expect(sources(widened, 'script-src')).toEqual(sources(csp, 'script-src'))
    expect(sources(widened, 'connect-src')).toEqual(expect.arrayContaining(['https://extra.example', 'https://swap.example', 'https://rpc.example']))
    expect(cspConnectOrigin('https://api.example/v1/path?q=1')).toBe('https://api.example')
    expect(cspConnectOrigin('wss://relay.example')).toBe('wss://relay.example')
    expect(cspConnectOrigin('https://*.example.com')).toBe('https://*.example.com')
    expect(cspConnectOrigin('https://rpc.example:8443/v1')).toBe('https://rpc.example:8443')
    expect(cspConnectOrigin('https://bücher.example')).toBe('https://xn--bcher-kva.example')
    for (const refused of ['http://api.example', 'ws://relay.example', 'javascript:alert(1)', 'data:text/html,x', 'https://a.example; script-src *', 'https://a.example;frame-src', 'https://a.example%3Bframe-src', 'https://a.example,b.example', 'https://a.example\'x', ' ', undefined]) {
      expect(cspConnectOrigin(refused), String(refused)).toBeNull()
    }
    const before = process.env.CSP_EXTRA_CONNECT_SRC
    process.env.CSP_EXTRA_CONNECT_SRC = 'https://ok.example/path, http://plain.example, https://ok.example, wss://socket.example, https://a.example;frame-src'
    try {
      expect(parseExtraConnectSrc()).toEqual(['https://ok.example', 'wss://socket.example'])
    }
    finally {
      if (before === undefined) delete process.env.CSP_EXTRA_CONNECT_SRC
      else process.env.CSP_EXTRA_CONNECT_SRC = before
    }
  })

  it('frames only WalletConnect\'s Verify page and AppKit\'s login frame, and allows no worker or other embedded content, base or form target', () => {
    expect(sources(csp, 'frame-src')).toEqual(['https://verify.walletconnect.org', 'https://secure.walletconnect.org'])
    expect(sources(csp, 'child-src')).toEqual(['\'none\''])
    expect(sources(csp, 'object-src')).toEqual(['\'none\''])
    expect(sources(csp, 'base-uri')).toEqual(['\'self\''])
    expect(sources(csp, 'form-action')).toEqual(['\'self\''])
    expect(sources(csp, 'worker-src')).toEqual(['\'none\''])
  })

  it('names only origins the browser contacts directly, before any deployment-configured origin', () => {
    expect(sources(csp, 'connect-src')).toEqual([
      '\'self\'',
      'https://api.web3modal.org',
      'https://rpc.walletconnect.org',
      'wss://relay.walletconnect.org',
      'https://pulse.walletconnect.org',
      'https://registry.npmjs.org',
      'https://cca-lite.coinbase.com',
      'https://www.walletlink.org',
      'wss://www.walletlink.org',
      'https://rpc.wallet.coinbase.com',
      'https://api.4byte.sourcify.dev',
      'https://api.cow.fi',
    ])
    expect(sources(csp, 'font-src')).toEqual(['\'self\'', 'https://fonts.reown.com'])
  })

  it('enforces the policy, with no report-only header and no report endpoint', () => {
    expect(csp).not.toMatch(/report-uri|report-to/)
    const plugin = readFileSync('server/plugins/csp.ts', 'utf8')
    expect(plugin).toContain('setResponseHeader(event, \'Content-Security-Policy\',')
    expect(plugin).not.toContain('Content-Security-Policy-Report-Only')
  })
})

describe('the per-response nonce', () => {
  const render = () => {
    let hook: ((html: Record<string, string[]>, context: { event: H3Event }) => void) | null = null
    const register = (_name: string, callback: typeof hook) => {
      hook = callback
    }
    ;(cspPlugin as unknown as (app: unknown) => void)({ hooks: { hook: register } })
    const headers: Record<string, string> = {}
    const setHeader = (name: string, value: string) => {
      headers[name] = value
    }
    const event = { node: { req: {}, res: { setHeader } } } as unknown as H3Event
    const html = {
      body: ['<div id="__nuxt"></div><script type="module" src="/_nuxt/entry.js"></script>'],
      bodyAppend: ['<script>window.__appended=1</script>'],
      bodyAttrs: [],
      bodyPrepend: ['<script>window.__prepended=1</script>'],
      head: ['<script>window.__APP_CONFIG__={}</script>'],
      htmlAttrs: [],
      island: [],
    }
    hook!(html, { event })
    return { headers, html }
  }

  it('is fresh for every response, at least 16 random bytes, and set on every script tag the page carries', () => {
    const first = render()
    const second = render()
    const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1] ?? ''
    const nonce = nonceOf(first.headers['Content-Security-Policy']!)
    expect(nonce).not.toBe(nonceOf(second.headers['Content-Security-Policy']!))
    expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16)
    for (const section of ['head', 'body', 'bodyPrepend', 'bodyAppend'] as const) {
      for (const chunk of first.html[section]!) {
        expect(chunk.split(`<script nonce="${nonce}"`).length, section).toBe(chunk.split(/<script(?=[\s>])/).length)
      }
    }
  })

  it('is never served twice from a cache: every page response is no-store for the browser and the CDN', () => {
    const config = readFileSync('nuxt.config.ts', 'utf8')
    const catchAll = config.slice(config.indexOf('\'/**\': {'))
    expect(catchAll).toMatch(/'Cache-Control': 'no-store, no-cache, must-revalidate'/)
    expect(catchAll).toMatch(/'CDN-Cache-Control': 'no-store'/)
    expect(catchAll).toMatch(/'Cloudflare-CDN-Cache-Control': 'no-store'/)
    expect(config).not.toMatch(/\b(swr|isr|prerender):/)
  })

  it('loads no external script or stylesheet that would need subresource integrity', () => {
    for (const file of ['nuxt.config.ts', 'app.vue']) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/src:\s*'https?:\/\//)
      expect(source, file).not.toMatch(/rel:\s*'stylesheet'/)
    }
  })
})
