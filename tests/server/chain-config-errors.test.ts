import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  manifest: [
    { chainId: 1, status: 'production', explorerUrl: 'https://etherscan.io' },
    { chainId: 146, status: 'deprecated' },
    { chainId: 137, status: 'unlisted' },
    { chainId: 8453, status: 'staging' },
  ],
  setResponseHeader: vi.fn(),
}))
vi.mock('~/server/api/internal/euler-chains.get', () => ({
  loadEulerChains: async () => mocks.manifest,
  peekEulerChains: () => mocks.manifest,
}))
vi.mock('h3', () => ({
  getQuery: () => ({ chainId: '1' }),
  getHeader: () => undefined,
  setResponseHeader: mocks.setResponseHeader,
  createError: (options: { statusMessage: string }) => Object.assign(new Error(options.statusMessage), options),
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: () => {} }) }))
vi.mock('~/server/utils/resolve-chain-id', () => ({ resolveChainId: () => 1 }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

type Html = { head: string[] }

const bootHtml = async () => {
  const { default: plugin } = await import('~/server/plugins/chain-config')
  const hooks = new Map<string, (html: Html) => Promise<void>>()
  plugin({ hooks: { hook: (name: string, callback: (html: Html) => Promise<void>) => hooks.set(name, callback) } } as never)
  return async () => {
    const html: Html = { head: [] }
    await hooks.get('render:html')!(html)
    return { html, config: JSON.parse(html.head[0].match(/window\.__CHAIN_CONFIG__=(.*)<\/script>/)![1]) }
  }
}

describe('HTML policy with invalid labels configuration', () => {
  let directory: string
  beforeEach(async () => {
    vi.resetModules()
    directory = await mkdtemp(join(tmpdir(), 'labels-policy-errors-'))
    vi.stubEnv('GEO_POLICY_CACHE_DIR', directory)
    for (const key of Object.keys(process.env).filter(key => /^RPC_URL_\d+$/.test(key))) vi.stubEnv(key, undefined)
    for (const { chainId } of mocks.manifest) vi.stubEnv(`RPC_URL_${chainId}`, 'https://rpc.example.test')
    for (const [key, value] of Object.entries({
      V3_API_URL: 'https://custom-indexer.example.test', DISABLE_V3: 'false', LABELS_SOURCE: 'v3',
      DOPPLER_ENVIRONMENT: 'prd', DEPRECATED_CHAINS: '', ONCHAIN_SDK_CHAINS: '1',
      LABELS_V3_SET: '', LABELS_V3_VERSION: '', LABELS_IMAGE_ORIGINS: '',
      STATIC_LABELS_BASE_URL: 'https://labels.example.test',
    })) vi.stubEnv(key, value)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected upstream request')))
    mocks.setResponseHeader.mockClear()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  it.each(['https://v3.euler.finance', 'https://custom-indexer.example.test'])(
    'renders unresolved HTML and rejects policy reads for invalid LABELS_SOURCE on %s', async (url) => {
      vi.stubEnv('V3_API_URL', url)
      vi.stubEnv('LABELS_SOURCE', 'invalid')
      const render = await bootHtml()
      const { html, config } = await render()
      expect(config).toMatchObject({
        enabledChainIds: [1, 146], deprecatedChainIds: [146], onchainSdkChainIds: [1],
        metadataOnlyChainIds: [], unresolvedChainIds: [1, 146], explorerUrls: { 1: 'https://etherscan.io' },
      })
      expect(html.head.join('')).not.toContain('operator.example')
      expect(html.head.join('')).not.toContain('rpc.example.test')
      const { default: labels } = await import('~/server/api/internal/public-labels.get')
      await expect(labels({} as never)).rejects.toMatchObject({ statusCode: 503, data: { code: 'LABELS_CONFIGURATION_ERROR' } })
      expect(mocks.setResponseHeader).toHaveBeenLastCalledWith({}, 'Cache-Control', 'no-store')
      const { default: policy } = await import('~/server/api/internal/chain-policy.get')
      await expect(policy({} as never)).rejects.toMatchObject({ name: 'LabelsConfigurationError' })
      const { loadServerChainReadPolicy } = await import('~/server/utils/chain-policy')
      await expect(loadServerChainReadPolicy(1)).rejects.toMatchObject({ name: 'LabelsConfigurationError' })
      expect(fetch).not.toHaveBeenCalled()

      vi.stubEnv('LABELS_SOURCE', 'v3')
      vi.stubEnv('V3_API_URL', 'https://custom-indexer.example.test')
      expect((await render()).config.unresolvedChainIds).toEqual([])
      await expect(policy({} as never)).resolves.toMatchObject({ chainId: 1, policy: { deprecated: false, onchain: true, metadataOnly: false } })
    },
  )

  it.each([
    ...[
      { LABELS_IMAGE_ORIGINS: 'https://images.example.test/path' },
      { LABELS_V3_SET: 'invalid/set' },
      { LABELS_V3_VERSION: 'draft' },
      { LABELS_SOURCE: 'static', STATIC_LABELS_BASE_URL: '' },
    ].flatMap(overrides => ['https://v3.euler.finance', 'https://custom-indexer.example.test'].map(url => [url, overrides] as const)),
    ['v3.operator.example', {}] as const,
  ])('keeps policy available while labels report configuration errors for %s with %j', async (url, overrides) => {
    vi.stubEnv('V3_API_URL', url)
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value)
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const path = new URL(input).pathname
      const data = path === '/v3/chains'
        ? [{ id: 1, capabilities: ['indexing'] }, { id: 146, capabilities: ['indexing'] }]
        : path.endsWith('/versions')
          ? [{ versionKey: 'v20260804151305236', status: 'published', isLatest: true }]
          : []
      return Response.json({ data, meta: { total: data.length, timestamp: new Date().toISOString() } })
    }))
    const render = await bootHtml()
    expect((await render()).config).toMatchObject({
      enabledChainIds: [1, 146], deprecatedChainIds: [146], onchainSdkChainIds: [1],
      metadataOnlyChainIds: [], unresolvedChainIds: [], explorerUrls: { 1: 'https://etherscan.io' },
    })
    const expected = { deprecated: false, onchain: true, metadataOnly: false }
    const { default: policy } = await import('~/server/api/internal/chain-policy.get')
    const { loadServerChainReadPolicy } = await import('~/server/utils/chain-policy')
    await expect(policy({} as never)).resolves.toEqual({ chainId: 1, policy: expected })
    await expect(loadServerChainReadPolicy(1)).resolves.toEqual(expected)

    const { default: labels } = await import('~/server/api/internal/public-labels.get')
    await expect(labels({} as never)).rejects.toMatchObject({ statusCode: 503, data: { code: 'LABELS_CONFIGURATION_ERROR' } })
    expect(mocks.setResponseHeader).toHaveBeenLastCalledWith({}, 'Cache-Control', 'no-store')

    for (const [key, value] of Object.entries({
      V3_API_URL: 'https://custom-indexer.example.test', LABELS_SOURCE: 'v3',
      LABELS_IMAGE_ORIGINS: '', LABELS_V3_SET: '', LABELS_V3_VERSION: '',
      STATIC_LABELS_BASE_URL: 'https://labels.example.test',
    })) vi.stubEnv(key, value)
    await expect(labels({} as never)).resolves.toMatchObject({ chainPolicy: expected })
    await expect(policy({} as never)).resolves.toEqual({ chainId: 1, policy: expected })
    expect((await render()).config.unresolvedChainIds).toEqual([])
  })
})
