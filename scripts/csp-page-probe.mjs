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
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    wait: { type: 'string', default: '10000' },
    channel: { type: 'string' },
  },
})
const URL_ARG = values.url
const WAIT_MS = Number(values.wait)
const CHANNEL = values.channel

// Node timers overflow above this limit and would silently skip the observation window.
if (!Number.isInteger(WAIT_MS) || WAIT_MS <= 0 || WAIT_MS > 2_147_483_647) {
  console.error('--wait must be an integer between 1 and 2147483647 milliseconds')
  process.exit(1)
}

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
