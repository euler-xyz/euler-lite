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
import { cspFailures, installCspMonitor } from './lib/csp-monitor.mjs'

const { values } = parseArgs({
  options: {
    'url': { type: 'string' },
    'wait': { type: 'string', default: '10000' },
    'channel': { type: 'string' },
    'expect-selector': { type: 'string' },
    'screenshot': { type: 'string' },
    'walletconnect': { type: 'boolean', default: false },
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
  const monitor = await installCspMonitor(context)
  const page = await context.newPage()
  let response
  let flowError
  let walletConnectQr = false
  try {
    response = await page.goto(URL_ARG, { waitUntil: 'domcontentloaded' })
    if (values['expect-selector']) await page.locator(values['expect-selector']).first().waitFor({ state: 'visible', timeout: WAIT_MS })
    if (values.walletconnect) {
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click({ timeout: WAIT_MS })
      await page.getByTestId('wallet-selector-walletconnect').click({ timeout: WAIT_MS })
      await page.locator('wui-qr-code[uri^="wc:"]').waitFor({ state: 'visible', timeout: WAIT_MS })
      if (!await page.getByRole('button', { name: 'Copy link', exact: true }).isEnabled()) {
        throw new Error('WalletConnect pairing link is unavailable')
      }
      walletConnectQr = true
    }
    await page.waitForTimeout(WAIT_MS)
  }
  catch (error) {
    flowError = error.message
  }
  if (values.screenshot) await page.screenshot({ path: values.screenshot, fullPage: true })
  const result = await page.evaluate(() => ({
    clientAnalytics: typeof window.ClientAnalytics,
    path: location.pathname,
  }))
  const policy = response?.headers()['content-security-policy'] ?? null
  const security = await monitor.snapshot()
  const failures = cspFailures(security, URL_ARG)
  if (flowError) failures.push(flowError)
  if (!response?.ok()) failures.push(`Page returned HTTP ${response?.status() ?? 'no response'}`)
  console.log(JSON.stringify({ url: URL_ARG, enforced: Boolean(policy), walletConnectQr, ...result, ...security, failures }, null, 2))
  if (failures.length) process.exitCode = 1
}
finally {
  await browser.close()
}
