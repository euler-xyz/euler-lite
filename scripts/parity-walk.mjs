#!/usr/bin/env node
/**
 * Standalone headed-Playwright walker for parity-style scenario JSON.
 *
 * Runs each scenario in `tests/parity/<file>.scenarios.json` against a single
 * running instance (defaults to http://localhost:3000). Useful for recording /
 * inspecting a user path through a migrated flow without diff-mode overhead.
 *
 * Action types supported (a strict subset + `fill`):
 *   { "type": "wait",    "ms": 1000 }
 *   { "type": "waitFor", "selector": "[data-id=\"foo\"]" }
 *   { "type": "click",   "selector": "..", "waitFor": ["..."], "settleMs": 500 }
 *   { "type": "fill",    "selector": "input[..]", "value": "1.5", "settleMs": 250 }
 *
 * Usage:
 *   node scripts/parity-walk.mjs \
 *     --scenarios tests/parity/sdk-flows.scenarios.json \
 *     [--url http://localhost:3000] \
 *     [--scenario sdk-earn-supply-review] \
 *     [--keep-open]
 *
 *  --keep-open leaves the browser open after the run (useful for visual review).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        flags[key] = true
      }
      else {
        flags[key] = next
        i++
      }
    }
  }
  return flags
}

const args = parseArgs(process.argv.slice(2))
const scenariosFile = path.resolve(ROOT_DIR, args.scenarios ?? 'tests/parity/sdk-flows.scenarios.json')
const baseUrl = String(args.url ?? 'http://localhost:3000').replace(/\/+$/, '')
const scenarioFilter = args.scenario ? String(args.scenario) : undefined
const keepOpen = Boolean(args['keep-open'])

void main().catch((err) => {
  console.error('[parity-walk]', err?.stack || err?.message || err)
  process.exit(1)
})

async function main() {
  const file = JSON.parse(await fs.readFile(scenariosFile, 'utf8'))
  const defaults = file.defaults ?? {}
  const scenarios = (file.scenarios ?? []).filter(s => !scenarioFilter || s.id === scenarioFilter)
  if (!scenarios.length) {
    throw new Error(`No scenarios matched (filter=${scenarioFilter ?? '*'})`)
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  try {
    for (const scenario of scenarios) {
      console.log(`[parity-walk] ▶ ${scenario.id} — ${scenario.label ?? ''}`)
      const ctx = await browser.newContext({
        viewport: defaults.viewport ?? { width: 1440, height: 1000 },
      })
      const page = await ctx.newPage()

      const merged = { ...defaults, ...scenario, localStorage: { ...(defaults.localStorage ?? {}), ...(scenario.localStorage ?? {}) } }
      if (merged.localStorage && Object.keys(merged.localStorage).length) {
        await ctx.addInitScript(({ entries }) => {
          for (const [k, v] of entries) {
            try {
              window.localStorage.setItem(k, v)
            }
            catch { /* ignore */ }
          }
        }, { entries: Object.entries(merged.localStorage) })
      }

      const url = baseUrl + (scenario.path.startsWith('/') ? scenario.path : `/${scenario.path}`)
      console.log(`[parity-walk]   navigating ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

      if (Array.isArray(merged.waitFor) && merged.waitFor.length) {
        for (const sel of merged.waitFor) {
          await page.locator(sel).first().waitFor({ state: 'visible', timeout: 30_000 })
        }
      }
      if (merged.settleMs) await page.waitForTimeout(Number(merged.settleMs))

      for (const action of (scenario.actions ?? [])) {
        const label = action.label ?? action.type
        console.log(`[parity-walk]   • ${action.type}: ${label}`)
        try {
          await performAction(page, action)
        }
        catch (err) {
          const outDir = path.join(ROOT_DIR, 'artifacts/parity-walk')
          await fs.mkdir(outDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const png = path.join(outDir, `${scenario.id}-${stamp}.png`)
          const html = path.join(outDir, `${scenario.id}-${stamp}.html`)
          await page.screenshot({ path: png, fullPage: true }).catch(() => {})
          await fs.writeFile(html, await page.content().catch(() => '')).catch(() => {})
          console.error(`[parity-walk]   ✗ ${action.type} failed — saved ${png} & ${html}`)
          throw err
        }
      }

      console.log(`[parity-walk]   ✓ done\n`)
      if (!keepOpen) {
        await ctx.close()
      }
    }
  }
  finally {
    if (!keepOpen) {
      await browser.close()
    }
    else {
      console.log('[parity-walk] --keep-open set; leaving browser running. Ctrl-C to exit.')
    }
  }
}

async function performAction(page, action) {
  const timeout = Number(action.timeoutMs ?? 30_000)

  if (action.type === 'wait') {
    await page.waitForTimeout(Number(action.ms ?? action.waitMs ?? 0))
    return
  }
  if (action.type === 'waitFor') {
    await page.locator(action.selector).first().waitFor({ state: 'visible', timeout })
    return
  }
  // For `optional` actions, probe with a shorter timeout and quietly skip when absent.
  const effectiveTimeout = action.optional ? Number(action.probeMs ?? 2_500) : timeout
  if (action.type === 'click') {
    const targetIndex = Number(action.index ?? 0)
    const locator = page.locator(action.selector).nth(targetIndex)
    try {
      await locator.waitFor({ state: 'visible', timeout: effectiveTimeout })
    }
    catch (err) {
      if (action.optional) {
        console.log(`[parity-walk]     (skipping optional click — selector not visible)`)
        return
      }
      throw err
    }
    await locator.click({ timeout })
  }
  else if (action.type === 'fill') {
    const targetIndex = Number(action.index ?? 0)
    const locator = page.locator(action.selector).nth(targetIndex)
    try {
      await locator.waitFor({ state: 'visible', timeout: effectiveTimeout })
    }
    catch (err) {
      if (action.optional) {
        console.log(`[parity-walk]     (skipping optional fill — selector not visible)`)
        return
      }
      throw err
    }
    await locator.click({ timeout })
    await locator.fill('', { timeout }).catch(() => {})
    await locator.type(String(action.value ?? ''), { delay: 30, timeout })
  }
  else {
    throw new Error(`Unsupported action type: ${action.type}`)
  }

  if (Array.isArray(action.waitFor)) {
    for (const sel of action.waitFor) {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout })
    }
  }
  if (action.settleMs !== undefined) {
    await page.waitForTimeout(Number(action.settleMs))
  }
}
