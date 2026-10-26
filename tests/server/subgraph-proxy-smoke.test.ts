import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, eventHandler, readBody, sendRedirect, toNodeListener } from 'h3'
import { expect, it, vi } from 'vitest'
import fixture from '../fixtures/subgraph/catalog.v1.json'
import { GRAPHQL_RESPONSE_BUDGET } from '~/server/utils/fetch-text-with-budget'

it.each([false, true])('enforces real proxy budgets and identity for imported=%s', async (imported) => {
  const handler = (await import('~/server/api/internal/proxy/subgraph/[chainId].post')).default
  const app = createApp()
  let upstreamCalls = 0
  let redirectedCalls = 0
  let mode: 'valid' | 'oversized' | 'drift' | 'redirect' = 'valid'
  const active = { ...fixture.deployments[0] }
  if (imported) {
    delete active.sourceCommit
    delete active.startBlock
  }
  app.use('/catalog', eventHandler(() => ({ ...fixture, deployments: [
    { ...active, endpoint: 'https://subgraph-fixture.invalid/query' }, fixture.deployments[1],
  ] })))
  app.use('/upstream', eventHandler(async (event) => {
    const body = await readBody(event)
    expect(body.query).toContain('_meta')
    upstreamCalls++
    if (mode === 'redirect') return sendRedirect(event, '/redirected', 302)
    return {
      data: { _meta: { deployment: mode === 'drift' ? 'another-deployment' : 'QmFixtureDeployment', block: { number: 123 } }, trackingActiveAccounts: [] },
      ...(mode === 'oversized' ? { padding: 'x'.repeat(GRAPHQL_RESPONSE_BUDGET.maxBytes + 1) } : {}),
    }
  }))
  app.use('/redirected', eventHandler(() => {
    redirectedCalls++
    return { data: { _meta: { deployment: 'QmFixtureDeployment' }, trackingActiveAccounts: [] } }
  }))
  app.use('/proxy', eventHandler(async (event) => {
    event.context.params = { chainId: event.path.endsWith('/8453') ? '8453' : '1' }
    return handler(event)
  }))
  const server = createServer(toNodeListener(app))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const origin = `http://127.0.0.1:${address.port}`
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://subgraph-fixture.invalid/query') return nativeFetch(`${origin}/upstream`, init)
    if (url.startsWith(`${origin}/`)) return nativeFetch(input, init)
    throw new Error('Smoke test prohibits external requests')
  })
  vi.stubEnv('SUBGRAPH_URL_1', '')
  vi.stubEnv('NUXT_PUBLIC_SUBGRAPH_URI_1', '')
  vi.stubEnv('SUBGRAPH_CATALOG_URL', `${origin}/catalog`)
  try {
    const query = { method: 'POST', body: JSON.stringify({ query: '{ _meta { deployment block { number } } trackingActiveAccounts { id } }' }) }
    const response = await fetch(`${origin}/proxy/1`, query)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-subgraph-source')).toMatch(/^[a-f0-9]{64}$/)
    expect(await response.json()).toMatchObject({ data: { trackingActiveAccounts: [] } })
    for (const failure of ['oversized', 'drift', 'redirect'] as const) {
      mode = failure
      const rejected = await fetch(`${origin}/proxy/1`, query)
      expect(rejected.status, failure).toBe(502)
      expect(rejected.headers.get('cache-control'), failure).toBe('no-store')
      await rejected.text()
    }
    expect(redirectedCalls).toBe(0)
    const retired = await fetch(`${origin}/proxy/8453`, query)
    expect(retired.status).toBe(503)
    expect(upstreamCalls).toBe(4)
  }
  finally {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
