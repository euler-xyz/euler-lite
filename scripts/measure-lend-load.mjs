#!/usr/bin/env node
/**
 * Measure time-to-first-row and time-to-N-rows on the /lend page.
 *
 * Uses Playwright directly (not MCP) so we can:
 *   - `addInitScript` to attach a MutationObserver BEFORE the first byte
 *     parses; the observer records `performance.now()` for each new row
 *     append. Timing is anchored to `performance.timeOrigin`.
 *   - `goto(url, { waitUntil: 'commit' })` so the script returns as soon
 *     as navigation commits, then awaits the observer milestones.
 *   - Use a fresh `browserContext` per trial — clears cookies, storage,
 *     and HTTP cache between runs.
 *
 * Usage:
 *   node scripts/measure-lend-load.mjs --url http://localhost:3000/lend?network=mainnet --trials 3
 *   node scripts/measure-lend-load.mjs --url https://app.euler.finance/lend?network=mainnet --trials 3
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
const TRIALS = Number(flag('trials', '3'))
const TARGET_ROWS = Number(flag('target', '5'))
const SELECTOR = flag('selector', 'a[href*="/lend/0x"]')
const TIMEOUT_MS = Number(flag('timeout', '60000'))
const VERBOSE = args.includes('--verbose')
const HEADED = args.includes('--headed')

if (!URL_ARG) {
  console.error('Usage: --url <url> [--trials N] [--target N] [--selector CSS]')
  process.exit(1)
}

const INIT_SCRIPT = `
  (() => {
    const probe = { events: [], started: false }
    window.__probe = probe

    const recordIfChanged = () => {
      const n = document.querySelectorAll(${JSON.stringify(SELECTOR)}).length
      const last = probe.events[probe.events.length - 1]
      if (!last || last.count !== n) {
        probe.events.push({ t: Math.round(performance.now()), count: n })
      }
    }

    const start = () => {
      if (probe.started) return
      probe.started = true
      // Immediate sample of whatever's in the DOM at observation start
      recordIfChanged()
      const observer = new MutationObserver(recordIfChanged)
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }

    if (document.documentElement) {
      start()
    } else {
      const i = setInterval(() => {
        if (document.documentElement) { clearInterval(i); start() }
      }, 5)
    }
  })()
`

const runTrial = async (browser, label) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(INIT_SCRIPT)

  const tWallStart = Date.now()
  await page.goto(URL_ARG, { waitUntil: 'commit', timeout: TIMEOUT_MS })

  // Poll the probe for the milestone. Swallow execution-context errors —
  // Cloudflare interstitials and similar redirects destroy the page
  // context, and addInitScript reinstalls on the new doc.
  const deadline = Date.now() + TIMEOUT_MS
  let milestone = null
  while (Date.now() < deadline) {
    try {
      const probe = await page.evaluate(() => window.__probe ?? null)
      if (probe?.events?.length) {
        const hit = probe.events.find(e => e.count >= TARGET_ROWS)
        if (hit) {
          milestone = { ...hit, all: probe.events }
          break
        }
      }
    }
    catch {
      // navigation interrupted; init script re-runs on the next doc.
    }
    await new Promise(f => setTimeout(f, 50))
  }

  const tWallEnd = Date.now()
  const finalCount = await page.evaluate(s => document.querySelectorAll(s).length, SELECTOR).catch(() => 0)
  const debug = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyChars: (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    scripts: document.querySelectorAll('script').length,
  })).catch(() => null)
  const nav = await page.evaluate(() => {
    /* eslint-disable */
    const n = performance.getEntriesByType('navigation')[0]
    const paint = performance.getEntriesByType('paint')
    return n
      ? {
          ttfb: Math.round(n.responseStart),
          dcl: Math.round(n.domContentLoadedEventEnd),
          load: Math.round(n.loadEventEnd),
          paint: Object.fromEntries(paint.map(p => [p.name, Math.round(p.startTime)])),
        }
      : null
  }).catch(() => null)

  await ctx.close()
  return {
    label,
    timed_out: milestone === null,
    wall_clock_ms: tWallEnd - tWallStart,
    nav,
    milestone,
    final_rows: finalCount,
    debug,
  }
}

const summary = (trials, key) => {
  const vals = trials.map(t => t.milestone?.t).filter(v => v != null)
  if (!vals.length) return { n: 0 }
  const sorted = [...vals].sort((a, b) => a - b)
  const mean = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)
  return {
    n: vals.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    mean,
  }
}

const main = async () => {
  const browser = await chromium.launch({ headless: !HEADED })
  console.log(`URL: ${URL_ARG}`)
  console.log(`Trials: ${TRIALS}, target=${TARGET_ROWS} rows, selector=${SELECTOR}`)
  console.log()
  const results = []
  for (let i = 0; i < TRIALS; i++) {
    const r = await runTrial(browser, `trial${i + 1}`)
    results.push(r)
    console.log(
      `  ${r.label}: ms_to_target=${r.milestone?.t ?? 'TIMEOUT'}  `
      + `final_rows=${r.final_rows}  ttfb=${r.nav?.ttfb}  fcp=${r.nav?.paint?.['first-contentful-paint']}`
      + `  wall=${r.wall_clock_ms}ms`,
    )
    if (r.timed_out && r.debug) {
      console.log(`    debug: title=${JSON.stringify(r.debug.title)} scripts=${r.debug.scripts} body="${r.debug.bodyChars}"`)
    }
    if (VERBOSE && r.milestone) {
      console.log(`    events:`, r.milestone.all.map(e => `${e.t}:${e.count}`).join('  '))
    }
  }
  console.log()
  console.log(`Summary (time-to-${TARGET_ROWS}-rows, ms):`, summary(results))
  await browser.close()
}

void main().catch(err => {
  console.error('measure-lend-load failed:', err?.stack ?? err)
  process.exit(1)
})
