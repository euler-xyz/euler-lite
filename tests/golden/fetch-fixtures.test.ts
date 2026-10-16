import { basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchDepositQuote: vi.fn(),
  fetchSwapQuotes: vi.fn(),
  getDeployment: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
  writeFileSync: mocks.writeFileSync,
}))

vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  DeploymentService: {
    build: vi.fn(async () => ({ getDeployment: mocks.getDeployment })),
  },
  SwapService: class {
    fetchDepositQuote = mocks.fetchDepositQuote
    fetchSwapQuotes = mocks.fetchSwapQuotes
  },
}))

const deployment = {
  evc: '0x0000000000000000000000000000000000000001',
  permit2: '0x0000000000000000000000000000000000000002',
  swapper: '0x0000000000000000000000000000000000000003',
  swapVerifier: '0x0000000000000000000000000000000000000004',
  accountLens: '0x0000000000000000000000000000000000000005',
}
const quote = { route: [{ providerName: 'Uniswap' }], amountIn: 100n }

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.getDeployment.mockReturnValue({
    addresses: {
      coreAddrs: { evc: deployment.evc, permit2: deployment.permit2 },
      peripheryAddrs: { swapper: deployment.swapper, swapVerifier: deployment.swapVerifier },
      lensAddrs: { accountLens: deployment.accountLens },
    },
  })
  mocks.fetchDepositQuote.mockResolvedValue([quote])
  mocks.fetchSwapQuotes.mockResolvedValue([quote])
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('golden fixture refresh', () => {
  it('leaves existing fixtures untouched when the second quote request fails', async () => {
    const error = new Error('quote request failed')
    mocks.fetchSwapQuotes.mockRejectedValue(error)

    await import('./fetch-fixtures')

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
    expect(console.error).toHaveBeenCalledWith(error)
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })

  it('leaves existing fixtures untouched when the second response has no supported quote', async () => {
    mocks.fetchSwapQuotes.mockResolvedValue([{ route: [{ providerName: 'CoW Swap' }] }])

    await import('./fetch-fixtures')

    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
    expect(console.error).toHaveBeenCalledWith(new Error('multiply: only CoW quotes returned'))
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
  })

  it('writes both quotes and their deployment only after both requests succeed', async () => {
    let finishRequest!: (quotes: typeof quote[]) => void
    mocks.fetchSwapQuotes.mockImplementation(() => new Promise((resolve) => {
      finishRequest = resolve
    }))

    await import('./fetch-fixtures')
    await vi.waitFor(() => expect(mocks.fetchSwapQuotes).toHaveBeenCalledOnce())
    const writesWhilePending = mocks.writeFileSync.mock.calls.length

    finishRequest([quote])
    await vi.waitFor(() => expect(mocks.writeFileSync).toHaveBeenCalledTimes(3))

    expect(writesWhilePending).toBe(0)
    const files = Object.fromEntries(mocks.writeFileSync.mock.calls.map(([path, json]) => [
      basename(path), JSON.parse(json),
    ]))
    expect(Object.keys(files).sort()).toEqual([
      'deployment.json', 'swap-collateral-usdc-to-dai.json', 'swap-multiply-usdc-to-dai.json',
    ])
    expect(files['deployment.json']).toEqual({ chainId: 1, ...deployment })
    expect(files['swap-collateral-usdc-to-dai.json']).toMatchObject({
      request: { amount: { $bigint: '1000000' } },
      quote: { amountIn: { $bigint: '100' } },
    })
    expect(files['swap-multiply-usdc-to-dai.json']).toMatchObject({
      request: { amount: { $bigint: '500000' } },
      quote: { amountIn: { $bigint: '100' } },
    })
    expect(process.exit).not.toHaveBeenCalled()
  })
})
