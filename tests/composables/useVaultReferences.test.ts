import { reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultType } from '@eulerxyz/euler-v2-sdk'

const STRATEGY = '0x6fe7fa90756434645f0b0428fdff78e99dda0fbc'
const COLLATERAL = '0x55f9bace2c864ac0d3392ea9fa654b605f21a3d3'
const EARN = '0x3b4802fdb0e5d74aa37d58fd77d63e93d4f9a4af'
const ESCROW = '0x00000000000000000000000000000000000000e5'
const SECURITIZE = '0x00000000000000000000000000000000000000d5'
const ADAPTER = '0x00000000000000000000000000000000000000a1'
const HOOK = '0x00000000000000000000000000000000000000b1'

const mocks = vi.hoisted(() => ({
  vaults: {} as Record<string, unknown>,
  products: {} as Record<string, { name: string }>,
  getOrFetch: vi.fn(),
  loadOracleAdapters: vi.fn(),
  route: { path: '/lend/0x0', query: { network: '1' } as Record<string, string> },
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getProductByVault: (address: string) => mocks.products[address.toLowerCase()] ?? { name: '' },
}))

vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  applyEulerLabelVaultOverrides: (product: unknown) => product,
}))

const evault = (address: string, symbol: string, extra: Record<string, unknown> = {}) => ({
  type: VaultType.EVault,
  address,
  asset: { symbol },
  shares: { name: `EVK Vault e${symbol}-1` },
  collaterals: [],
  ...extra,
})

let oracleAdapters: Record<string, { label?: string, name?: string }>

const load = async () => {
  vi.resetModules()
  return (await import('~/composables/useVaultReferences')).useVaultReferences()
}

beforeEach(() => {
  mocks.vaults = {
    [STRATEGY]: evault(STRATEGY, 'USDC'),
    [EARN]: { type: VaultType.EulerEarn, address: EARN, asset: { symbol: 'USDC' }, shares: { name: 'K3 Capital Earn USDC' } },
    [ESCROW]: evault(ESCROW, 'wstETH'),
    [SECURITIZE]: { type: VaultType.SecuritizeCollateral, address: SECURITIZE, asset: { symbol: 'ACRED' }, shares: { name: 'ACRED' } },
  }
  mocks.products = { [STRATEGY]: { name: 'AlphaGrowth Cap' }, [ESCROW]: { name: 'Escrow' } }
  mocks.getOrFetch.mockReset().mockResolvedValue(undefined)
  mocks.loadOracleAdapters.mockReset().mockResolvedValue(undefined)
  mocks.route = { path: '/lend/0x0', query: { network: '1' } }
  oracleAdapters = reactive({ [ADAPTER]: { label: 'Chainlink USDC/USD' } })
  vi.stubGlobal('useRoute', () => mocks.route)
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useVaultRegistry', () => ({
    get: (address: string) => mocks.vaults[address.toLowerCase()] ? { vault: mocks.vaults[address.toLowerCase()] } : undefined,
    getOrFetch: mocks.getOrFetch,
    getVaultCategory: (address: string) => address.toLowerCase() === ESCROW ? 'escrow' : 'standard',
    registryVersion: ref(0),
  }))
  vi.stubGlobal('useEulerLabels', () => ({ oracleAdapters, loadOracleAdapters: mocks.loadOracleAdapters }))
})

afterEach(() => vi.unstubAllGlobals())

describe('useVaultReferences.describe', () => {
  it('names a vault by product and asset and links its page on the current network', async () => {
    const { describe: describeAddress } = await load()
    expect(describeAddress(STRATEGY)).toEqual({ kind: 'vault', label: 'AlphaGrowth Cap USDC', to: { path: `/lend/${STRATEGY}`, query: { network: '1' } } })
    expect(describeAddress(EARN)).toMatchObject({ label: 'K3 Capital Earn USDC', to: { path: `/earn/${EARN}` } })
  })

  it('names escrow by its asset, keeps a Securitize vault unlinked and names an adapter by its label', async () => {
    const { describe: describeAddress } = await load()
    expect(describeAddress(ESCROW).label).toBe('Escrowed wstETH')
    expect(describeAddress(SECURITIZE)).toEqual({ kind: 'vault', label: 'ACRED' })
    expect(describeAddress(ADAPTER)).toEqual({ kind: 'adapter', label: 'Chainlink USDC/USD' })
  })

  it('keeps the sentence\'s own spelling for an address it cannot name', async () => {
    const { describe: describeAddress } = await load()
    expect(describeAddress(HOOK, '0x000000…00b1')).toEqual({ kind: 'address', label: '0x000000…00b1' })
  })
})

describe('useVaultReferences.ensureResolved', () => {
  it('fetches only a check\'s own subject as a vault, and sends oracle addresses to the adapter loader', async () => {
    const { ensureResolved } = await load()
    ensureResolved([
      { key: `collateral.${COLLATERAL}.visible`, parts: [{ text: 'x', address: COLLATERAL }] },
      { key: 'hooks.zero-or-trusted', parts: [{ text: 'x', address: HOOK }] },
      { key: 'oracle.adapters-recognized', parts: [{ text: 'a', address: '0x00000000000000000000000000000000000000a2' }, { text: 'b', address: ADAPTER }] },
      { key: 'scheduled.oracle.router', parts: [{ text: 'c', address: '0x00000000000000000000000000000000000000a3' }] },
    ])
    expect(mocks.getOrFetch.mock.calls).toEqual([[COLLATERAL]])
    expect(mocks.loadOracleAdapters).toHaveBeenCalledWith(1, ['0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3'])
  })

  it('does not ask again for a vault that was not found, but asks again for one the registry dropped', async () => {
    const { ensureResolved } = await load()
    const line = { key: `collateral.${COLLATERAL}.visible`, parts: [] }
    ensureResolved([line])
    await vi.waitFor(() => expect(mocks.getOrFetch).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    ensureResolved([line])
    expect(mocks.getOrFetch).toHaveBeenCalledTimes(1)

    const other = '0x00000000000000000000000000000000000000c2'
    mocks.getOrFetch.mockResolvedValue({ address: other })
    ensureResolved([{ key: `collateral.${other}.visible`, parts: [] }])
    await Promise.resolve()
    ensureResolved([{ key: `collateral.${other}.visible`, parts: [] }])
    expect(mocks.getOrFetch).toHaveBeenCalledTimes(3)
  })

  it('asks for a missing adapter once while it loads and not again after it was not found', async () => {
    let finish!: () => void
    mocks.loadOracleAdapters.mockReturnValue(new Promise<void>((resolve) => {
      finish = resolve
    }))
    const { ensureResolved } = await load()
    const line = { key: 'oracle.adapters-recognized', parts: [{ text: 'a', address: '0x00000000000000000000000000000000000000a2' }] }
    ensureResolved([line])
    ensureResolved([line])
    finish()
    await vi.waitFor(() => expect(mocks.loadOracleAdapters).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    ensureResolved([line])
    expect(mocks.loadOracleAdapters).toHaveBeenCalledTimes(1)
  })
})

describe('useVaultReferences.oracleLinkFor', () => {
  const VAULT = '0x2a356443fee07703266066c6bb1b11b82d8246ad'
  const line = { anchor: `oracle-adapter-${ADAPTER}`, adapter: ADAPTER }

  beforeEach(() => {
    mocks.vaults[VAULT] = evault(VAULT, 'USDC', {
      collaterals: [{ address: COLLATERAL, borrowLTV: 0.8, oracleRoute: { steps: [{ oracle: ADAPTER }] } }],
    })
  })

  it('links in place when this page shows the adapter', async () => {
    const { oracleLinkFor } = await load()
    expect(oracleLinkFor(line, VAULT, true)).toEqual({ query: { network: '1' }, hash: `#oracle-adapter-${ADAPTER}` })
  })

  it('links the borrow page of the collateral the adapter prices otherwise', async () => {
    const { oracleLinkFor } = await load()
    expect(oracleLinkFor(line, VAULT, false)).toEqual({
      path: `/borrow/${COLLATERAL}/${VAULT}`,
      query: { network: '1' },
      hash: `#oracle-adapter-${ADAPTER}`,
    })
  })

  it('has no link when that borrow page is the current one, or the vault is not an EVK vault', async () => {
    mocks.route = { path: `/borrow/${COLLATERAL}/${VAULT}`, query: {} }
    const { oracleLinkFor } = await load()
    expect(oracleLinkFor(line, VAULT, false)).toBeUndefined()
    expect(oracleLinkFor(line, EARN, false)).toBeUndefined()
  })
})
