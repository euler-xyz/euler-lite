#!/usr/bin/env node
// Browser-enforced negative controls. Code under test runs in nonce-authorized page scripts,
// never in Playwright.evaluate (which bypasses the page's CSP).
import http from 'node:http'
import { parseArgs } from 'node:util'
import { chromium, webkit } from 'playwright'
import { installCspMonitor } from './lib/csp-monitor.mjs'

const { values } = parseArgs({ options: {
  url: { type: 'string' },
  browser: { type: 'string', default: 'chromium' },
  channel: { type: 'string' },
} })
if (!values.url || !['chromium', 'webkit'].includes(values.browser)) {
  throw new Error('Usage: --url <production-build URL> [--browser chromium|webkit] [--channel chrome]')
}
const source = await fetch(values.url, { signal: AbortSignal.timeout(15000) })
if (!source.ok) throw new Error(`Policy source returned HTTP ${source.status}`)
const policy = source.headers.get('content-security-policy')
const html = await source.text()
const nonce = policy?.match(/'nonce-([A-Za-z0-9+/=_-]+)'/)?.[1]
if (!nonce) throw new Error('Policy source must have an enforced nonce-based CSP')

function controls() {
  const probe = window.__cspControls = { violations: [], checks: {}, markers: {}, complete: false }
  document.addEventListener('securitypolicyviolation', event => probe.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }))
  probe.markers.nonce = true
  document.addEventListener('DOMContentLoaded', async () => {
    const seen = (directive, blocked) => probe.violations.some(event => event.directive === directive && (!blocked || event.blocked.includes(blocked)))
    document.querySelector('#event').click()
    try {
      eval('window.__cspControls.markers.eval = true')
    }
    catch { /* The assertion also requires a CSP violation. */ }
    try {
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
      probe.markers.wasm = true
    }
    catch (error) { probe.markers.wasmError = { name: error.name, message: error.message } }
    const worker = (url, Constructor = Worker) => {
      try {
        const instance = new Constructor(url)
        instance.onerror = event => event.preventDefault()
        setTimeout(() => instance.terminate?.(), 500)
      }
      catch { /* Some engines reject synchronously. */ }
    }
    worker('/worker.js')
    worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'application/javascript' })))
    worker('/shared.js', SharedWorker)
    const pending = [
      navigator.serviceWorker.register('/sw.js').catch(() => {}),
      fetch('https://blocked.invalid/csp-smoke').catch(() => {}),
      fetch('/ok').then(response => probe.markers.fetch = response.ok),
    ]
    try {
      const socket = new WebSocket('wss://blocked.invalid/csp-smoke')
      socket.onerror = () => {}
    }
    catch { /* Expected. */ }
    const script = document.createElement('script')
    script.src = '/dynamic.js'
    document.body.append(script)
    for (const src of ['/inside', 'https://blocked.invalid/frame']) {
      const frame = document.createElement('iframe')
      frame.src = src
      document.body.append(frame)
    }
    const base = document.createElement('base')
    base.href = 'https://blocked.invalid/base/'
    document.head.append(base)
    document.querySelector('form').submit()
    await Promise.all(pending)
    await new Promise(resolve => setTimeout(resolve, 1000))
    probe.checks = {
      nonceScriptAllowed: probe.markers.nonce === true,
      sameOriginFetchAllowed: probe.markers.fetch === true,
      trustedDynamicScriptAllowed: probe.markers.dynamic === true,
      parserInlineBlocked: !probe.markers.inline && seen('script-src-elem', 'inline'),
      wrongNonceBlocked: !probe.markers.wrongNonce && seen('script-src-elem', 'inline'),
      parserExternalBlocked: !probe.markers.external && seen('script-src-elem', '/parser.js'),
      eventHandlerBlocked: !probe.markers.event && seen('script-src-attr'),
      evalBlocked: !probe.markers.eval && seen('script-src', 'eval'),
      // WebKit rejects compilation without emitting a separate violation event.
      wasmBlocked: !probe.markers.wasm && (seen('script-src', 'wasm-eval')
        || (probe.markers.wasmError?.name === 'CompileError' && /content security policy|unsafe-eval/i.test(probe.markers.wasmError.message))),
      fetchBlocked: seen('connect-src', 'https://blocked.invalid'),
      socketBlocked: seen('connect-src', 'wss://blocked.invalid'),
      workerBlocked: seen('worker-src', '/worker.js'),
      sharedWorkerBlocked: seen('worker-src', '/shared.js'),
      blobWorkerBlocked: seen('worker-src', 'blob'),
      serviceWorkerBlocked: seen('worker-src', '/sw.js'),
      sameOriginFrameBlocked: seen('frame-src', '/inside'),
      externalFrameBlocked: seen('frame-src', 'https://blocked.invalid'),
      externalBaseBlocked: new URL(document.baseURI).origin === location.origin && seen('base-uri'),
      externalFormBlocked: seen('form-action'),
      objectBlocked: seen('object-src'),
    }
    probe.complete = true
  })
}

const requests = []
const server = http.createServer((request, response) => {
  requests.push(request.url)
  response.setHeader('Cache-Control', 'no-store')
  if (request.url.startsWith('/observer')) {
    response.setHeader('Content-Type', 'text/html')
    response.setHeader('Content-Security-Policy', `script-src 'nonce-${nonce}'; frame-src 'self'`)
    response.end(request.url === '/observer'
      ? `<script nonce="${nonce}">window.open('/observer-popup')</script><iframe src="/observer-child"></iframe>`
      : `<script>window.forbidden = true</script><script nonce="${nonce}">if (window.opener) { window.ClientAnalytics = {}; setTimeout(() => window.close(), 500) }</script>`)
    return
  }
  if (request.url === '/ok') {
    response.end('ok')
    return
  }
  if (request.url.endsWith('.js')) {
    response.setHeader('Content-Type', 'text/javascript')
    response.end(request.url === '/dynamic.js' ? 'window.__cspControls.markers.dynamic = true' : request.url === '/parser.js' ? 'window.__cspControls.markers.external = true' : 'postMessage(1)')
    return
  }
  if (request.url === '/inside') {
    response.end('Forbidden frame')
    return
  }
  response.setHeader('Content-Type', 'text/html')
  response.setHeader('Content-Security-Policy', policy)
  response.end(`<!doctype html><title>CSP controls</title>
    <script nonce="${nonce}">(${controls.toString()})()</script>
    <script>window.__cspControls.markers.inline = true</script>
    <script nonce="wrong">window.__cspControls.markers.wrongNonce = true</script>
    <script src="/parser.js"></script>
    <button id="event" onclick="window.__cspControls.markers.event = true">Control</button>
    <form action="https://blocked.invalid/form"></form>
    <object data="data:text/html,blocked" type="text/html"></object>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await ({ chromium, webkit })[values.browser].launch({ headless: true, ...(values.channel ? { channel: values.channel } : {}) })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__cspControls?.complete, null, { timeout: 15000 })
  const result = await page.evaluate(() => window.__cspControls)
  const forbiddenRequests = requests.filter(url => ['/parser.js', '/worker.js', '/shared.js', '/sw.js', '/inside'].includes(url))
  const failures = Object.entries(result.checks).filter(([, passed]) => !passed).map(([name]) => name)
  if (forbiddenRequests.length) failures.push('Forbidden requests reached the fixture server')
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? []
  const second = await fetch(values.url, { signal: AbortSignal.timeout(15000) })
  const secondNonce = second.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1]
  const headers = {
    allScriptsNonced: scriptTags.length > 0 && scriptTags.every(tag => tag.includes(`nonce="${nonce}"`) || tag.includes(`nonce='${nonce}'`)),
    freshNonce: Boolean(secondNonce && secondNonce !== nonce),
    noStore: /\bno-store\b/.test(source.headers.get('cache-control') ?? ''),
  }
  failures.push(...Object.entries(headers).filter(([, passed]) => !passed).map(([name]) => name))
  // A separate permissive fixture verifies observation of violations inside an iframe
  // and a popup that closes before snapshot(). It does not test the app policy.
  const observerContext = await browser.newContext()
  const monitor = await installCspMonitor(observerContext)
  const observerPage = await observerContext.newPage()
  await observerPage.goto(`http://127.0.0.1:${server.address().port}/observer`)
  await observerPage.waitForTimeout(1500)
  const observed = await monitor.snapshot()
  const monitorSelfTest = {
    childFrameAndClosedPopup: ['/observer-child', '/observer-popup'].every(path => observed.violations.some(event => event.frame.endsWith(path))),
    closedPopupAnalytics: observed.analytics.length > 0,
  }
  failures.push(...Object.entries(monitorSelfTest).filter(([, passed]) => !passed).map(([name]) => name))
  await observerContext.close()
  console.log(JSON.stringify({ headers, monitorSelfTest, monitorObservations: observed, browser: values.browser, policySource: values.url, ...result, requests, failures }, null, 2))
  if (failures.length) process.exitCode = 1
}
finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
