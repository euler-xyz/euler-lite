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
import { buildCsp } from '~/server/plugins/csp'
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

  it('allows HelpScout Beacon API and chat traffic', () => {
    const connectSrc = csp
      .split(';')
      .map(d => d.trim())
      .find(d => d.startsWith('connect-src'))
    expect(connectSrc).toContain('https://beaconapi.helpscout.net')
    expect(connectSrc).toContain('https://chatapi.helpscout.net')
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
