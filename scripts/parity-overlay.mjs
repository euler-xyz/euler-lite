import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import process from 'node:process'
import { chromium } from 'playwright'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000
const READY_TIMEOUT_MS = 120_000

const overlayInitScript = `
(() => {
  if (window.__PARITY_OVERLAY__) return

  const STYLE_ID = '__parity_data_overlay_style__'
  const TOOLBAR_ID = '__parity_data_overlay_toolbar__'
  const DIFF_PANEL_ID = '__parity_data_overlay_diff_panel__'
  let scheduled = false

  const hashHue = (value) => {
    let hash = 0
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
    }
    return Math.abs(hash) % 360
  }

  const describe = (element) => {
    const parts = []
    const id = element.getAttribute('data-id')
    const list = element.getAttribute('data-list')
    const field = element.getAttribute('data-field')
    const key = element.getAttribute('data-key')
    const value = element.getAttribute('data-value')

    if (id) parts.push('id=' + id)
    if (list) parts.push('list=' + list)
    if (field) parts.push('field=' + field)
    if (key) parts.push('key=' + key)
    if (value) parts.push('value=' + value)

    return parts.join(' | ')
  }

  const diffForCurrentPage = () => {
    const diff = window.__PARITY_DIFF__
    if (!diff || !diff.pages) return null

    const path = window.location.pathname + window.location.search
    return diff.pages[path] || diff.pages[window.location.pathname] || null
  }

  const baseParityKey = (element) => [
    element.getAttribute('data-id') || '',
    element.getAttribute('data-list') || '',
    element.getAttribute('data-key') || '',
    element.getAttribute('data-field') || '',
  ].join('|')

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return

    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      'html[data-parity-overlay="off"] [data-id] { outline: none !important; box-shadow: none !important; }',
      'html[data-parity-overlay="on"] :where([data-id]) {',
      '  --parity-hue: 205;',
      '  outline: 1.5px solid hsl(var(--parity-hue) 92% 48% / 0.92) !important;',
      '  outline-offset: 2px !important;',
      '  box-shadow: inset 0 0 0 9999px hsl(var(--parity-hue) 92% 58% / 0.035) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id]):not(svg):not(g):not(path):not(circle):not(line):not(polyline):not(polygon):not(text) {',
      '  position: relative !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id="data-point"]) {',
      '  border-radius: 4px !important;',
      '  background: hsl(var(--parity-hue) 92% 58% / 0.07) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="match"]) {',
      '  outline-color: rgb(34 197 94 / 0.95) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(34 197 94 / 0.045) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="value-mismatch"]) {',
      '  outline: 2px solid rgb(220 38 38 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(220 38 38 / 0.09) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="missing-in-candidate"]) {',
      '  outline: 2px solid rgb(245 158 11 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(245 158 11 / 0.11) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status="extra-in-candidate"]) {',
      '  outline: 2px solid rgb(168 85 247 / 0.98) !important;',
      '  box-shadow: inset 0 0 0 9999px rgb(168 85 247 / 0.11) !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id])::after {',
      '  content: attr(data-id);',
      '  position: absolute !important;',
      '  top: -10px !important;',
      '  left: 0 !important;',
      '  z-index: 2147483646 !important;',
      '  max-width: min(260px, 80vw) !important;',
      '  padding: 1px 5px !important;',
      '  border-radius: 3px !important;',
      '  background: hsl(var(--parity-hue) 92% 28% / 0.94) !important;',
      '  color: white !important;',
      '  font: 10px/14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  letter-spacing: 0 !important;',
      '  white-space: nowrap !important;',
      '  overflow: hidden !important;',
      '  text-overflow: ellipsis !important;',
      '  pointer-events: none !important;',
      '}',
      'html[data-parity-overlay="on"] :where([data-id][data-field])::after {',
      '  content: attr(data-id) " " attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-id="data-point"][data-field])::after {',
      '  content: attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status][data-field])::after {',
      '  content: attr(data-parity-status) " " attr(data-field);',
      '}',
      'html[data-parity-overlay="on"] :where([data-parity-status]:not([data-field]))::after {',
      '  content: attr(data-parity-status) " " attr(data-id);',
      '}',
      'html[data-parity-overlay="on"][data-parity-labels="off"] :where([data-id])::after {',
      '  display: none !important;',
      '}',
      '#' + TOOLBAR_ID + ' {',
      '  position: fixed !important;',
      '  right: 12px !important;',
      '  bottom: 12px !important;',
      '  z-index: 2147483647 !important;',
      '  display: flex !important;',
      '  gap: 8px !important;',
      '  align-items: center !important;',
      '  padding: 8px 10px !important;',
      '  border: 1px solid rgb(255 255 255 / 0.18) !important;',
      '  border-radius: 6px !important;',
      '  background: rgb(12 18 28 / 0.9) !important;',
      '  color: white !important;',
      '  box-shadow: 0 8px 30px rgb(0 0 0 / 0.24) !important;',
      '  font: 12px/16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  letter-spacing: 0 !important;',
      '  pointer-events: none !important;',
      '}',
      '#' + TOOLBAR_ID + ' strong { color: #8fd3ff !important; font-weight: 700 !important; }',
      '#' + TOOLBAR_ID + ' span { color: rgb(255 255 255 / 0.7) !important; }',
      '#' + DIFF_PANEL_ID + ' {',
      '  position: fixed !important;',
      '  left: 12px !important;',
      '  bottom: 12px !important;',
      '  z-index: 2147483647 !important;',
      '  max-width: min(560px, calc(100vw - 24px)) !important;',
      '  max-height: 36vh !important;',
      '  overflow: auto !important;',
      '  padding: 10px 12px !important;',
      '  border: 1px solid rgb(255 255 255 / 0.18) !important;',
      '  border-radius: 6px !important;',
      '  background: rgb(12 18 28 / 0.92) !important;',
      '  color: white !important;',
      '  box-shadow: 0 8px 30px rgb(0 0 0 / 0.24) !important;',
      '  font: 12px/16px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;',
      '  pointer-events: auto !important;',
      '}',
      '#' + DIFF_PANEL_ID + ' strong { color: #fca5a5 !important; }',
      '#' + DIFF_PANEL_ID + ' div { margin-top: 4px !important; }',
      '#' + DIFF_PANEL_ID + ' code { color: #d1d5db !important; }',
    ].join('\\n')

    document.head.appendChild(style)
  }

  const ensureToolbar = () => {
    let toolbar = document.getElementById(TOOLBAR_ID)
    if (toolbar) return toolbar

    toolbar = document.createElement('div')
    toolbar.id = TOOLBAR_ID
    toolbar.setAttribute('aria-hidden', 'true')
    document.body.appendChild(toolbar)
    return toolbar
  }

  const ensureDiffPanel = () => {
    let panel = document.getElementById(DIFF_PANEL_ID)
    if (panel) return panel

    panel = document.createElement('div')
    panel.id = DIFF_PANEL_ID
    panel.setAttribute('aria-hidden', 'true')
    document.body.appendChild(panel)
    return panel
  }

  const applyMetadata = () => {
    const elements = document.querySelectorAll('[data-id]')
    const pageDiff = diffForCurrentPage()
    const occurrenceByBaseKey = new Map()

    elements.forEach((element) => {
      const baseKey = baseParityKey(element)
      const occurrence = occurrenceByBaseKey.get(baseKey) || 0
      const parityKey = baseKey + '#' + occurrence
      occurrenceByBaseKey.set(baseKey, occurrence + 1)

      const seed = [
        element.getAttribute('data-id') || '',
        element.getAttribute('data-list') || '',
        element.getAttribute('data-field') || '',
      ].join(':')

      element.style.setProperty('--parity-hue', String(hashHue(seed)))
      element.setAttribute('data-parity-tagged', 'true')
      element.setAttribute('data-parity-key', parityKey)

      const status = pageDiff?.statuses?.[parityKey]
      if (status) {
        element.setAttribute('data-parity-status', status)
      } else {
        element.removeAttribute('data-parity-status')
      }

      const description = describe(element)
      if (description) element.setAttribute('data-parity-label', description)
    })
  }

  const updateDiffPanel = () => {
    const pageDiff = diffForCurrentPage()
    const existing = document.getElementById(DIFF_PANEL_ID)

    if (!pageDiff || !pageDiff.problems || pageDiff.problems.length === 0) {
      if (existing) existing.remove()
      return
    }

    const panel = ensureDiffPanel()
    const visibleProblems = pageDiff.problems.slice(0, 12)
    panel.innerHTML =
      '<strong>' + pageDiff.problems.length + ' parity discrepancies</strong>' +
      visibleProblems.map(problem =>
        '<div><code>' + problem.status + '</code> ' + (problem.field || problem.id || problem.key) + '</div>',
      ).join('') +
      (pageDiff.problems.length > visibleProblems.length ? '<div>...and ' + (pageDiff.problems.length - visibleProblems.length) + ' more</div>' : '')
  }

  const updateToolbar = () => {
    const toolbar = ensureToolbar()
    const tagged = document.querySelectorAll('[data-id]').length
    const dataPoints = document.querySelectorAll('[data-id="data-point"]').length
    const lists = document.querySelectorAll('[data-list]').length
    const overlay = document.documentElement.getAttribute('data-parity-overlay') === 'on' ? 'on' : 'off'
    const labels = document.documentElement.getAttribute('data-parity-labels') === 'on' ? 'on' : 'off'
    const pageDiff = diffForCurrentPage()
    const problems = pageDiff?.problems?.length || 0

    toolbar.innerHTML =
      '<strong>parity tags</strong>' +
      '<span>' + tagged + ' tagged</span>' +
      '<span>' + dataPoints + ' data</span>' +
      '<span>' + lists + ' lists</span>' +
      (pageDiff ? '<span>' + problems + ' diffs</span>' : '') +
      '<span>Alt+P ' + overlay + '</span>' +
      '<span>Alt+L labels ' + labels + '</span>'
  }

  const refresh = () => {
    scheduled = false
    ensureStyle()

    if (!document.documentElement.hasAttribute('data-parity-overlay')) {
      document.documentElement.setAttribute('data-parity-overlay', 'on')
    }

    if (!document.documentElement.hasAttribute('data-parity-labels')) {
      document.documentElement.setAttribute('data-parity-labels', 'on')
    }

    applyMetadata()
    updateDiffPanel()
    updateToolbar()
  }

  const scheduleRefresh = () => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(refresh)
  }

  const show = () => {
    document.documentElement.setAttribute('data-parity-overlay', 'on')
    scheduleRefresh()
  }

  const hide = () => {
    document.documentElement.setAttribute('data-parity-overlay', 'off')
    scheduleRefresh()
  }

  const toggle = () => {
    if (document.documentElement.getAttribute('data-parity-overlay') === 'on') hide()
    else show()
  }

  const toggleLabels = () => {
    const current = document.documentElement.getAttribute('data-parity-labels')
    document.documentElement.setAttribute('data-parity-labels', current === 'on' ? 'off' : 'on')
    scheduleRefresh()
  }

  window.__PARITY_OVERLAY__ = {
    refresh,
    show,
    hide,
    toggle,
    toggleLabels,
  }

  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

    if (event.code === 'KeyP') {
      event.preventDefault()
      toggle()
    }

    if (event.code === 'KeyL') {
      event.preventDefault()
      toggleLabels()
    }
  })

  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-id', 'data-list', 'data-key', 'data-field', 'data-value'],
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refresh, { once: true })
  } else {
    refresh()
  }
})()
`

const args = parseArgs(process.argv.slice(2))

if (args.flags.help || args.flags.h) {
  printHelp()
  process.exit(0)
}

void main().catch((error) => {
  console.error('[parity-overlay] ' + (error?.stack || error?.message || error))
  process.exit(1)
})

async function main() {
  const positional = args.positionals[0]
  const target = await resolveTarget(positional)
  const diffPath = valueOf('diff') || process.env.PARITY_DIFF
  const diffSide = valueOf('side') || process.env.PARITY_DIFF_SIDE || 'candidate'
  const diffPayload = diffPath ? await loadOverlayDiff(diffPath, diffSide) : null
  const state = {
    browser: null,
  }
  const serverProcess = target.serverProcess
  let shuttingDown = false

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true

    if (state.browser?.isConnected()) {
      await state.browser.close().catch(() => {})
    }

    await stopServer(serverProcess)
    process.exit(exitCode)
  }

  process.once('SIGINT', () => void shutdown(0))
  process.once('SIGTERM', () => void shutdown(0))

  if (serverProcess) {
    await waitForHttp(target.baseUrl, READY_TIMEOUT_MS, serverProcess)
  }
  else {
    await waitForHttp(target.url.href, READY_TIMEOUT_MS)
  }

  state.browser = await launchBrowser()
  state.browser.on('disconnected', () => void shutdown(0))

  const context = await state.browser.newContext({
    viewport: {
      width: Number(process.env.PARITY_VIEWPORT_WIDTH || 1440),
      height: Number(process.env.PARITY_VIEWPORT_HEIGHT || 1000),
    },
  })

  if (diffPayload) {
    await context.addInitScript({ content: 'window.__PARITY_DIFF__ = ' + JSON.stringify(diffPayload) })
  }
  await context.addInitScript({ content: overlayInitScript })

  const page = await context.newPage()
  console.log('[parity-overlay] Opening ' + target.url.href)
  console.log('[parity-overlay] Shortcuts: Alt+P toggles borders, Alt+L toggles labels. Close the browser or press Ctrl+C to stop.')
  if (diffPayload) {
    console.log('[parity-overlay] Loaded diff for ' + diffSide + ' side from ' + diffPath)
  }

  await page.goto(target.url.href, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await page.evaluate(() => window.__PARITY_OVERLAY__?.refresh?.())

  const counts = await page.evaluate(() => ({
    tagged: document.querySelectorAll('[data-id]').length,
    dataPoints: document.querySelectorAll('[data-id="data-point"]').length,
    lists: document.querySelectorAll('[data-list]').length,
  }))

  console.log(
    '[parity-overlay] Initial page has '
    + counts.tagged
    + ' tagged elements, '
    + counts.dataPoints
    + ' data points, '
    + counts.lists
    + ' list markers.',
  )

  await new Promise(() => {})
}

async function loadOverlayDiff(filePath, side) {
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'))
  const diff = raw.diff ? JSON.parse(await fs.readFile(raw.diff, 'utf8')) : raw
  const pages = {}

  for (const page of diff.pages || []) {
    const pageUrl = new URL(side === 'baseline' ? page.baselineUrl : page.candidateUrl)
    const pageKey = pageUrl.pathname + pageUrl.search
    const statuses = {}
    const problems = []

    for (const item of page.elementDiffs || []) {
      statuses[item.key] = item.status

      if (item.status !== 'match') {
        const source = side === 'baseline' ? item.baseline : item.candidate
        problems.push({
          key: item.key,
          status: item.status,
          id: source?.id || item.baseline?.id || item.candidate?.id || '',
          field: source?.field || item.baseline?.field || item.candidate?.field || '',
          list: source?.list || item.baseline?.list || item.candidate?.list || '',
          itemKey: source?.itemKey || item.baseline?.itemKey || item.candidate?.itemKey || '',
        })
      }
    }

    for (const listDiff of page.listDiffs || []) {
      if (listDiff.status === 'match') continue
      problems.push({
        key: 'list:' + listDiff.list,
        status: listDiff.status,
        id: 'list',
        field: listDiff.list,
        list: listDiff.list,
        itemKey: '',
      })
    }

    for (const captureError of page.captureErrors || []) {
      problems.push({
        key: 'capture-error:' + captureError.side,
        status: 'capture-error',
        id: 'page',
        field: captureError.side,
        list: '',
        itemKey: '',
      })
    }

    for (const consoleError of page.consoleErrors || []) {
      problems.push({
        key: 'console-error:' + consoleError.side,
        status: 'console-error',
        id: 'page',
        field: consoleError.side,
        list: '',
        itemKey: '',
      })
    }

    pages[pageKey] = {
      pageId: page.pageId,
      status: page.status,
      summary: page.summary,
      baselineUrl: page.baselineUrl,
      candidateUrl: page.candidateUrl,
      statuses,
      problems,
    }
  }

  return {
    side,
    runId: diff.runId,
    pages,
  }
}

async function resolveTarget(positional) {
  if (isHttpUrl(positional)) {
    return {
      url: new URL(positional),
      baseUrl: originOf(positional),
      serverProcess: null,
    }
  }

  if (process.env.PARITY_URL) {
    const base = new URL(process.env.PARITY_URL)
    return {
      url: positional ? new URL(normalizePath(positional), base) : base,
      baseUrl: originOf(base.href),
      serverProcess: null,
    }
  }

  const host = process.env.PARITY_HOST || DEFAULT_HOST
  const startPort = Number(process.env.PARITY_PORT || DEFAULT_PORT)
  const port = await findFreePort(host, startPort)
  const baseUrl = 'http://' + host + ':' + port
  const path = positional || process.env.PARITY_PATH || '/'

  return {
    url: new URL(normalizePath(path), baseUrl),
    baseUrl,
    serverProcess: startDevServer(host, port),
  }
}

function startDevServer(host, port) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npmCommand, ['run', 'dev', '--', '--host', host, '--port', String(port)], {
    env: {
      ...process.env,
      BROWSER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => process.stderr.write(chunk))

  child.once('exit', (code, signal) => {
    if (code || signal) {
      console.error('[parity-overlay] Dev server exited with code=' + code + ' signal=' + signal)
    }
  })

  return child
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return

  child.kill('SIGTERM')

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
      resolve()
    }, 4_000)

    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function launchBrowser() {
  const headless = process.env.PARITY_HEADLESS === '1'
  const channel = process.env.PARITY_BROWSER_CHANNEL === 'none'
    ? undefined
    : process.env.PARITY_BROWSER_CHANNEL || 'chrome'

  if (channel) {
    try {
      return await chromium.launch({ channel, headless })
    }
    catch (error) {
      console.warn('[parity-overlay] Could not launch Chromium channel "' + channel + '": ' + error.message)
      console.warn('[parity-overlay] Falling back to Playwright-managed Chromium.')
    }
  }

  try {
    return await chromium.launch({ headless })
  }
  catch (error) {
    throw new Error(
      'Could not launch a browser. Install Playwright Chromium with "npx playwright install chromium" or set PARITY_BROWSER_CHANNEL to an installed channel. Original error: '
      + error.message,
    )
  }
}

async function waitForHttp(url, timeoutMs, serverProcess) {
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeoutMs) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error('Dev server exited before becoming ready.')
    }

    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (response.status < 500) return
      lastError = new Error('HTTP ' + response.status)
    }
    catch (error) {
      lastError = error
    }

    await sleep(500)
  }

  throw new Error('Timed out waiting for ' + url + '. Last error: ' + (lastError?.message || lastError))
}

async function findFreePort(host, startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortFree(host, port)) return port
  }

  throw new Error('No free port found between ' + startPort + ' and ' + (startPort + 49))
}

function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen(port, host)
  })
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function normalizePath(value) {
  if (!value || value === '.') return '/'
  return value.startsWith('/') ? value : '/' + value
}

function originOf(value) {
  const url = new URL(value)
  return url.origin
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`
Usage:
  npm run parity:overlay
  npm run parity:overlay -- /earn
  PARITY_URL=http://127.0.0.1:3000 npm run parity:overlay
  PARITY_DIFF=artifacts/parity/latest-run.json npm run parity:overlay -- /lend?network=1

Options and environment:
  First arg                  Route path or full URL to open.
  --diff <file>              Load diff.json or latest-run.json and highlight parity status.
  --side <side>              Diff side to render: candidate or baseline. Default: candidate.
  PARITY_URL                 Attach to an existing app URL instead of starting dev.
  PARITY_PATH                Route path when no first arg is provided.
  PARITY_DIFF                Same as --diff.
  PARITY_DIFF_SIDE           Same as --side.
  PARITY_HOST                Dev server host. Default: ${DEFAULT_HOST}
  PARITY_PORT                First dev server port to try. Default: ${DEFAULT_PORT}
  PARITY_BROWSER_CHANNEL     Browser channel. Default: chrome. Use "none" for bundled Chromium.
  PARITY_HEADLESS=1          Run headless.
  PARITY_VIEWPORT_WIDTH      Browser viewport width. Default: 1440
  PARITY_VIEWPORT_HEIGHT     Browser viewport height. Default: 1000

In the browser:
  Alt+P toggles tag borders.
  Alt+L toggles tag labels.
`)
}

function parseArgs(argv) {
  const flags = {}
  const positionals = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }

    const trimmed = arg.replace(/^--?/, '')
    const [key, inlineValue] = trimmed.split('=', 2)
    const next = argv[index + 1]

    if (inlineValue !== undefined) {
      flags[key] = inlineValue
    }
    else if (next && !next.startsWith('-')) {
      flags[key] = next
      index += 1
    }
    else {
      flags[key] = true
    }
  }

  return { flags, positionals }
}

function valueOf(name) {
  const value = args.flags[name]
  return typeof value === 'string' ? value : null
}
