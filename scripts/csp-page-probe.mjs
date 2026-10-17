#!/usr/bin/env node
/**
 * Load a deployed page in a fresh browser context and fail on any CSP violation
 * or on Coinbase's analytics bundle running (window.ClientAnalytics).
 *
 * The violation listener is attached by addInitScript, in the page itself:
 * Playwright's evaluate runs outside the page's CSP and cannot be used to probe it.
 *
 * Usage:
 *   node scripts/csp-page-probe.mjs --url https://dev-build-euler-lite-pr-909.up.railway.app/ [--wait 10000] [--channel chrome]
 */
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]
  return v?.startsWith('--') ? def : (v ?? def)
}

const URL_ARG = flag('url')
const WAIT_MS = Number(flag('wait', '10000'))
const CHANNEL = flag('channel')

if (!URL_ARG) {
  console.error('Usage: --url <url> [--wait ms] [--channel chrome]')
  process.exit(1)
}

const browser = await chromium.launch({ headless: true, ...(CHANNEL ? { channel: CHANNEL } : {}) })
try {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile })
    })
  })
  const page = await context.newPage()
  const response = await page.goto(URL_ARG, { waitUntil: 'load' })
  await page.waitForTimeout(WAIT_MS)
  const result = await page.evaluate(() => ({
    clientAnalytics: typeof window.ClientAnalytics,
    path: location.pathname,
    violations: window.__cspViolations,
  }))
  const policy = response?.headers()['content-security-policy'] ?? null
  console.log(JSON.stringify({ url: URL_ARG, enforced: Boolean(policy), ...result }, null, 2))
  if (!policy || result.violations.length > 0 || result.clientAnalytics !== 'undefined') process.exitCode = 1
}
finally {
  await browser.close()
}
