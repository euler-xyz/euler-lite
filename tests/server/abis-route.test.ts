import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
  setResponseHeader: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: vi.fn() }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const BRANCH_ENV_KEYS = [
  'EULER_SDK_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL',
] as const

const originalEnv = Object.fromEntries(BRANCH_ENV_KEYS.map(key => [key, process.env[key]]))

const fn = (name: string, inputTypes: string[], stateMutability = 'view') => ({
  type: 'function',
  name,
  inputs: inputTypes.map(type => ({ name: '', type })),
  outputs: [{ name: '', type: 'bytes' }],
  stateMutability,
})

// Minimal ABIs satisfying each contract's required canonical signatures.
const VALID_ABIS = {
  AccountLens: [
    fn('getEVCAccountInfo', ['address', 'address']),
    fn('getVaultAccountInfo', ['address', 'address']),
  ],
  UtilsLens: [fn('computeAPYs', ['uint256', 'uint256', 'uint256', 'uint256'], 'pure')],
  VaultLens: [fn('getVaultInterestRateModelInfo', ['address', 'uint256[]', 'uint256[]'])],
} as const

// The module holds cache state, so every test imports a fresh copy.
const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/abis/[contract].get')
}

describe('/api/internal/abis/[contract]', () => {
  afterEach(() => {
    for (const key of BRANCH_ENV_KEYS) {
      const original = originalEnv[key]
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('fetches the contract ABI from the configured interfaces branch', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.VaultLens))

    const { refreshAbi } = await importRoute()

    await expect(refreshAbi('VaultLens')).resolves.toEqual(VALID_ABIS.VaultLens)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/account-lens-update/abis/VaultLens.json',
    )
  })

  it('prioritizes the explicit ABIs base URL over a configured interfaces branch', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    process.env.NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL = 'https://abis.example/mirror/'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.AccountLens))

    const { refreshAbi } = await importRoute()
    await refreshAbi('AccountLens')

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://abis.example/mirror/AccountLens.json',
    )
  })

  it.each([
    ['non-array payload', { error: 'nope' }],
    ['empty ABI', []],
    ['items without a type', [{ name: 'getVaultInterestRateModelInfo' }]],
    // Right name, but missing inputs/outputs/stateMutability — viem would
    // derive a wrong selector from this fragment.
    ['function fragment without inputs', [{ type: 'function', name: 'getVaultInterestRateModelInfo' }]],
    // Structurally complete fragment whose canonical signature does not
    // match what the consumers encode.
    ['wrong required signature', [fn('getVaultInterestRateModelInfo', ['address'])]],
    // Valid fragments, but the contract's required function is absent.
    ['missing required function', [fn('somethingElse', ['address'])]],
    // Right name and inputs, but a stripped outputs tuple — viem would
    // decode the lens return data as undefined.
    ['required function with empty outputs', [{
      ...fn('getVaultInterestRateModelInfo', ['address', 'uint256[]', 'uint256[]']),
      outputs: [],
    }]],
    // Outputs present but not ABI parameters.
    ['malformed output entries', [{
      ...fn('getVaultInterestRateModelInfo', ['address', 'uint256[]', 'uint256[]']),
      outputs: [42],
    }]],
  ])('rejects an unusable 200 payload (%s)', async (_label, payload) => {
    for (const key of BRANCH_ENV_KEYS) Reflect.deleteProperty(process.env, key)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(payload))

    const { refreshAbi } = await importRoute()

    await expect(refreshAbi('VaultLens')).rejects.toThrow('invalid ABI payload')
  })

  it('validates required signatures per contract', async () => {
    // A valid VaultLens ABI is not a valid AccountLens ABI.
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.VaultLens))

    const { refreshAbi } = await importRoute()

    await expect(refreshAbi('AccountLens')).rejects.toThrow('invalid ABI payload')
  })

  it('keeps serving the last-known-good ABI when a later 200 is unusable', async () => {
    vi.useFakeTimers()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.AccountLens))

    const { loadAbi } = await importRoute()
    await expect(loadAbi('AccountLens')).resolves.toEqual(VALID_ABIS.AccountLens)

    // Past the TTL an array-shaped but empty 200 must not overwrite the
    // valid entry — the stale value wins.
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))
    await expect(loadAbi('AccountLens')).resolves.toEqual(VALID_ABIS.AccountLens)

    // Neither must a non-empty 200 whose fragments carry the right names
    // but omit inputs/outputs/mutability (wrong selector shape).
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([
      { type: 'function', name: 'getEVCAccountInfo' },
      { type: 'function', name: 'getVaultAccountInfo' },
    ]))
    await expect(loadAbi('AccountLens')).resolves.toEqual(VALID_ABIS.AccountLens)

    // Nor one with correct signatures whose outputs tuples were stripped —
    // encodable but undecodable.
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(
      VALID_ABIS.AccountLens.map(item => ({ ...item, outputs: [] })),
    ))
    await expect(loadAbi('AccountLens')).resolves.toEqual(VALID_ABIS.AccountLens)
  })

  it('serves stale cache during a prolonged outage, up to the manifest window', async () => {
    vi.useFakeTimers()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.VaultLens))

    const { loadAbi } = await importRoute()
    await expect(loadAbi('VaultLens')).resolves.toEqual(VALID_ABIS.VaultLens)

    vi.advanceTimersByTime(60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadAbi('VaultLens')).resolves.toEqual(VALID_ABIS.VaultLens)

    vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadAbi('VaultLens')).rejects.toThrow('upstream down')
  })

  it('throws when upstream fails and no cache exists', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))

    const { loadAbi } = await importRoute()

    await expect(loadAbi('VaultLens')).rejects.toThrow('upstream down')
  })

  it('serves fresh cache without refetching', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.UtilsLens))

    const { loadAbi } = await importRoute()
    await loadAbi('UtilsLens')
    await expect(loadAbi('UtilsLens')).resolves.toEqual(VALID_ABIS.UtilsLens)

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('404s on a contract outside the allowlist', async () => {
    const route = await importRoute()

    await expect(
      route.default({ params: { contract: 'NotALens' } } as never),
    ).rejects.toMatchObject({ statusCode: 404 })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('serves an allowlisted contract through the handler', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(VALID_ABIS.AccountLens))

    const route = await importRoute()

    await expect(
      route.default({ params: { contract: 'AccountLens' } } as never),
    ).resolves.toEqual(VALID_ABIS.AccountLens)
  })
})
