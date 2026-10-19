// Install before creating pages: bindings and init scripts also cover child frames and popups.
export async function installCspMonitor(context) {
  const violations = []
  const documents = []
  const analytics = []
  const pageErrors = []
  const failedRequests = []
  const webSocketErrors = []
  const pending = new Set()
  await context.exposeBinding('__recordCspViolation', ({ frame }, event) => {
    violations.push({ frame: safeUrl(frame.url()), ...event, blocked: safeUrl(event.blocked), source: safeUrl(event.source) })
  })
  await context.exposeBinding('__recordClientAnalytics', ({ frame }, type) => {
    analytics.push({ frame: safeUrl(frame.url()), type })
  })
  await context.addInitScript(() => {
    const timer = setInterval(() => {
      if (typeof window.ClientAnalytics !== 'undefined') {
        clearInterval(timer)
        void window.__recordClientAnalytics(typeof window.ClientAnalytics)
      }
    }, 100)
    window.addEventListener('securitypolicyviolation', (event) => {
      void window.__recordCspViolation({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
        disposition: event.disposition,
      })
    })
  })
  context.on('page', (page) => {
    page.on('pageerror', error => pageErrors.push({ page: safeUrl(page.url()), message: error.message }))
    page.on('websocket', (socket) => {
      socket.on('socketerror', error => webSocketErrors.push({ url: safeUrl(socket.url()), error: String(error) }))
    })
  })
  context.on('requestfailed', request => failedRequests.push({ url: safeUrl(request.url()), error: request.failure()?.errorText }))
  context.on('response', (response) => {
    if (response.request().resourceType() !== 'document') return
    track(response.allHeaders().then((headers) => {
      documents.push({ url: safeUrl(response.url()), status: response.status(), enforced: Boolean(headers['content-security-policy']) })
    }))
  })
  function track(promise) {
    const observed = promise.catch(() => {})
    pending.add(observed)
    void observed.finally(() => pending.delete(observed))
  }
  return {
    checkpoint: () => ({ violations: violations.length, documents: documents.length, analytics: analytics.length, pageErrors: pageErrors.length, failedRequests: failedRequests.length, webSocketErrors: webSocketErrors.length }),
    async snapshot(since = {}) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          try {
            const type = await frame.evaluate(() => typeof window.ClientAnalytics)
            if (type !== 'undefined') analytics.push({ frame: safeUrl(frame.url()), type })
          }
          catch { /* A frame can close or navigate while being observed. */ }
        }
      }
      await Promise.all([...pending])
      return Object.fromEntries(Object.entries({ violations, documents, analytics, pageErrors, failedRequests, webSocketErrors })
        .map(([key, entries]) => [key, entries.slice(since[key] ?? 0)]))
    },
  }
}

export function cspFailures(result, appUrl) {
  const origin = new URL(appUrl).origin
  const appDocuments = result.documents.filter(document => document.url.startsWith(`${origin}/`) && document.status >= 200 && document.status < 300)
  return [
    ...(!appDocuments.length ? ['No successful app document was observed'] : []),
    ...(appDocuments.some(document => !document.enforced) ? ['An app document has no enforced CSP'] : []),
    ...(result.violations.length ? [`${result.violations.length} CSP violation(s)`] : []),
    ...(result.analytics.length ? ['Coinbase ClientAnalytics was present'] : []),
  ]
}

function safeUrl(value) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  }
  catch { return value }
}
