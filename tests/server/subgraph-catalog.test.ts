import fixture from '../fixtures/subgraph/catalog.v1.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSubgraphResolver, parseSubgraphCatalog } from '~/server/utils/subgraph-catalog'
import { MANIFEST_MAX_STALE_MS } from '~/server/utils/euler-interfaces'

const active = (chainId = 1) => ({ chainId, family: 'euler-simple', channel: 'stable', status: 'active', version: '1.2.3.4', endpoint: 'https://index.example/query', deploymentId: 'cid-1', capabilities: ['account-vault-discovery', 'vault-factory-lookup'], sourceCommit: 'a'.repeat(40), startBlock: 0 })
const catalog = (deployments: unknown[] = [active()]) => ({ schemaVersion: 1, revision: 'r1', publishedAt: '2026-10-19T00:00:00Z', deployments })
const streamedResponse = (chunks: Uint8Array[]) => {
  let index = 0
  const cancel = vi.fn()
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++])
    else controller.close()
  })
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  return { response: new Response(body), pull, cancel }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('subgraph catalog resolution', () => {
  it('accepts the shared producer fixture and its authoritative retirement', async () => {
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, fetchCatalog: async () => fixture })
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'QmFixtureDeployment' })
    await expect(resolve(8453)).rejects.toMatchObject({ reason: 'retired' })
  })
  it('retains explicit and compatibility URL precedence without reading catalog', async () => {
    const fetchCatalog = vi.fn()
    const env = { SUBGRAPH_URL_1: ' http://private/query?key=secret ', NUXT_PUBLIC_SUBGRAPH_URI_1: '/custom', SUBGRAPH_CATALOG_URL: 'https://catalog.example' }
    const resolve = createSubgraphResolver({ env, fetchCatalog })
    expect((await resolve(1)).endpoint).toBe('http://private/query?key=secret')
    env.SUBGRAPH_URL_1 = ''
    expect((await resolve(1)).endpoint).toBe('/custom')
    expect(fetchCatalog).not.toHaveBeenCalled()
  })
  it('supports explicit per-chain disable and global catalog opt-out', async () => {
    const fetchCatalog = vi.fn()
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_DISABLED_1: 'true', SUBGRAPH_URL_1: 'https://custom', SUBGRAPH_CATALOG_URL: 'https://catalog', SUBGRAPH_CATALOG_DISABLED: 'true' }, fetchCatalog })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'disabled' })
    await expect(resolve(2)).rejects.toMatchObject({ reason: 'missing' })
    expect(fetchCatalog).not.toHaveBeenCalled()
  })
  it('quarantines duplicates/invalid chains while ignoring candidate and unrelated families', async () => {
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, fetchCatalog: async () => catalog([
      active(), active(), { ...active(2), endpoint: 'https://index.example?token=secret' }, active(3),
      { ...active(3), channel: 'candidate' }, { ...active(3), family: 'another-family' },
      { ...active(4), capabilities: ['vault-factory-lookup'] }, { ...active(5), status: 'retired', endpoint: undefined },
    ]) })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'invalid' })
    await expect(resolve(2)).rejects.toMatchObject({ reason: 'invalid' })
    expect((await resolve(3)).deploymentId).toBe('cid-1')
    await expect(resolve(4)).rejects.toMatchObject({ reason: 'unsupported-capability' })
    await expect(resolve(5)).rejects.toMatchObject({ reason: 'retired' })
    await expect(resolve(6)).rejects.toMatchObject({ reason: 'missing' })
  })
  it('rejects unknown schema and malformed envelopes', () => {
    expect(() => parseSubgraphCatalog({ ...catalog(), schemaVersion: 2 })).toThrow()
    expect(() => parseSubgraphCatalog({ ...catalog(), deployments: null })).toThrow()
  })
  it('single-flights refresh, bounds last-good age, and never extends it on failure', async () => {
    let time = 0
    const fetchCatalog = vi.fn().mockResolvedValue(catalog())
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, now: () => time, fetchCatalog })
    await Promise.all([resolve(1), resolve(1)])
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    time = 60_000
    fetchCatalog.mockRejectedValue(new Error('offline'))
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-1' })
    time = 60_001
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-1' })
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    time = MANIFEST_MAX_STALE_MS - 1
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-1' })
    expect(fetchCatalog).toHaveBeenCalledTimes(3)
    time = MANIFEST_MAX_STALE_MS
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    // The last-good limit applies during backoff too; failed reads never renew it.
    expect(fetchCatalog).toHaveBeenCalledTimes(3)
    time += 10_000
    fetchCatalog.mockResolvedValue(catalog([{ ...active(), deploymentId: 'cid-2' }]))
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-2' })
  })
  it('applies retirement immediately on successful refresh and retains it through transport failure', async () => {
    let time = 0
    const fetchCatalog = vi.fn().mockResolvedValue(catalog())
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, now: () => time, fetchCatalog })
    await resolve(1)
    time = 60_000
    fetchCatalog.mockResolvedValue(catalog([{ ...active(), status: 'retired' }]))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'retired' })
    time = 24 * 60 * 60_000
    fetchCatalog.mockRejectedValue(new Error('offline'))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'retired' })
  })
  it('does not revive omitted chains after a successful empty catalog', async () => {
    let time = 0
    const fetchCatalog = vi.fn().mockResolvedValue(catalog())
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, now: () => time, fetchCatalog })
    await resolve(1)
    time = 60_000
    fetchCatalog.mockResolvedValue(catalog([]))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'missing' })
    time = 24 * 60 * 60_000
    fetchCatalog.mockRejectedValue(new Error('offline'))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'missing' })
  })
  it('never uses another catalog URL’s last-good snapshot during failure or recovery', async () => {
    let time = 0
    const env = { SUBGRAPH_CATALOG_URL: 'first' }
    const fetchCatalog = vi.fn().mockResolvedValue(catalog())
    const resolve = createSubgraphResolver({ env, now: () => time, fetchCatalog })
    await resolve(1)
    env.SUBGRAPH_CATALOG_URL = 'second'
    fetchCatalog.mockRejectedValue(new Error('offline'))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(fetchCatalog).toHaveBeenLastCalledWith('second')
    time = 10_000
    fetchCatalog.mockResolvedValue(catalog([{ ...active(), deploymentId: 'cid-second' }]))
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-second' })
    env.SUBGRAPH_CATALOG_URL = 'first'
    fetchCatalog.mockRejectedValue(new Error('offline'))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
  })
  it('backs off cold failures without a cached snapshot', async () => {
    let time = 0
    const fetchCatalog = vi.fn().mockRejectedValue(new Error('offline'))
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'fixture' }, now: () => time, fetchCatalog })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(fetchCatalog).toHaveBeenCalledOnce()
    time = 10_000
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
  })

  it('cancels an oversized stream as soon as it crosses the byte limit', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(catalog()).padEnd(1_000_001, ' '))
    const { response, pull, cancel } = streamedResponse([
      bytes.subarray(0, 500_000), bytes.subarray(500_000, 1_000_000), bytes.subarray(1_000_000),
      new Uint8Array(100_000).fill(32),
    ])
    cancel.mockImplementation(() => new Promise<void>(() => {}))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'https://fixture' } })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pull).toHaveBeenCalledTimes(3)
  })

  it('rejects multibyte catalogs whose byte size exceeds the limit even when their string length does not', async () => {
    const text = JSON.stringify({ ...catalog(), revision: '€'.repeat(400_000) })
    const bytes = new TextEncoder().encode(text)
    expect(text.length).toBeLessThan(1_000_000)
    expect(bytes.byteLength).toBeGreaterThan(1_000_000)
    const { response, cancel } = streamedResponse([bytes.subarray(0, 600_000), bytes.subarray(600_000)])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'https://fixture' } })
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('accepts exactly the byte limit and preserves UTF-8 split across chunks', async () => {
    const deploymentId = 'cid-€'
    const bytes = new TextEncoder().encode(JSON.stringify(catalog([{ ...active(), deploymentId }])))
    const split = bytes.indexOf(0xe2) + 1
    const { response, cancel } = streamedResponse([
      bytes.subarray(0, split), bytes.subarray(split),
      new Uint8Array(1_000_000 - bytes.byteLength).fill(32),
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'https://fixture' } })
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps the last-good snapshot after an oversized refresh without extending its lifetime', async () => {
    let time = 0
    const oversized = { ...catalog([{ ...active(), status: 'retired' }]), revision: '€'.repeat(400_000) }
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(catalog()))
      .mockImplementation(async () => Response.json(oversized))
    vi.stubGlobal('fetch', fetch)
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'https://fixture' }, now: () => time })
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-1' })
    time = 60_000
    await expect(resolve(1)).resolves.toMatchObject({ deploymentId: 'cid-1' })
    time = MANIFEST_MAX_STALE_MS
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('bounds a stalled body and ignores its eventual completion', async () => {
    vi.useFakeTimers()
    let bodyController!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller },
    })
    const fetch = vi.fn().mockResolvedValue(new Response(body))
    vi.stubGlobal('fetch', fetch)
    const resolve = createSubgraphResolver({ env: { SUBGRAPH_CATALOG_URL: 'https://fixture' } })
    const first = resolve(1)
    const rejected = expect(first).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify(catalog())))
    bodyController.close()
    await Promise.resolve()
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'catalog-unavailable' })
    expect(fetch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    fetch.mockResolvedValue(Response.json(catalog([{ ...active(), status: 'retired' }])))
    await expect(resolve(1)).rejects.toMatchObject({ reason: 'retired' })
  })
})
