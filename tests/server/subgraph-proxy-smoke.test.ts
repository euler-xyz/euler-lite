import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, eventHandler, readBody, toNodeListener } from 'h3'
import { expect, it, vi } from 'vitest'
import fixture from '../fixtures/subgraph/catalog.v1.json'

it('smokes the real HTTP proxy with local catalog and upstream fixtures only', async () => {
  const handler = (await import('~/server/api/internal/proxy/subgraph/[chainId].post')).default
  const app = createApp()
  let upstreamCalls = 0
  app.use('/catalog', eventHandler(() => ({ ...fixture, deployments: [
    { ...fixture.deployments[0], endpoint: 'https://subgraph-fixture.invalid/query' }, fixture.deployments[1],
  ] })))
  app.use('/upstream', eventHandler(async (event) => {
    const body = await readBody(event)
    expect(body.query).toContain('_meta')
    upstreamCalls++
    return { data: { _meta: { deployment: 'QmFixtureDeployment', block: { number: 123 } }, trackingActiveAccounts: [] } }
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
    const retired = await fetch(`${origin}/proxy/8453`, query)
    expect(retired.status).toBe(503)
    expect(upstreamCalls).toBe(1)
  }
  finally {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
