import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the balance auto-refetch loop.
 *
 * Wallets connected through WalletConnect commonly report their address in
 * lowercase rather than EIP-55 checksummed form (injected wallets checksum).
 * needsFetch() used to compare the stored checksummed address against the raw
 * connector address with a cased string compare, so a lowercase address kept
 * needsFetch() true forever and the finally-block follow-up refetched
 * balances in an unbounded loop, hanging the tab (Chrome RESULT_CODE_HUNG).
 */

const CHECKSUMMED = '0x904788be730704B53B55E0654A9D659B3A9ce0a7'
const LOWERCASE = CHECKSUMMED.toLowerCase()
const VAULT_ASSET = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

const fetchWallet = vi.fn(async () => ({ errors: [], result: { assets: [] } }))
const logWarn = vi.fn()

vi.mock('~/utils/errorHandling', () => ({
  logWarn: (...args: unknown[]) => logWarn(...args),
}))
vi.mock('~/composables/useVaults', () => ({
  useVaults: () => ({ loadedChainId: ref(1) }),
}))
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({
    getByType: () => [{ asset: { address: VAULT_ASSET } }],
  }),
}))
vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkForChain: async () => ({ walletService: { fetchWallet } }),
}))
vi.mock('~/composables/useTxBatch', () => ({
  activeLayerWalletBalancesRef: ref({}),
}))

const effectiveAddress = ref<string | undefined>(undefined)
const isConnected = ref(true)
const isSpyMode = ref(false)
const chainId = ref(1)

const flush = () => new Promise(resolve => setTimeout(resolve, 25))

describe('useWallets balance refetch', () => {
  beforeEach(() => {
    fetchWallet.mockReset()
    fetchWallet.mockImplementation(async () => ({ errors: [], result: { assets: [] } }))
    logWarn.mockClear()
    isConnected.value = true
    isSpyMode.value = false
    chainId.value = 1

    vi.stubGlobal('useEffectiveAddress', () => ({ isConnected, isSpyMode, effectiveAddress }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  })

  afterEach(async () => {
    const { useWallets } = await import('~/composables/useWallets')
    useWallets().resetBalances()
    vi.unstubAllGlobals()
  })

  it('fetches once for a lowercase (non-checksummed) connector address', async () => {
    effectiveAddress.value = LOWERCASE
    const { useWallets } = await import('~/composables/useWallets')
    useWallets()
    await flush()
    expect(fetchWallet).toHaveBeenCalledTimes(1)
  })

  it('fetches once for a checksummed connector address', async () => {
    effectiveAddress.value = CHECKSUMMED
    const { useWallets } = await import('~/composables/useWallets')
    useWallets()
    await flush()
    expect(fetchWallet).toHaveBeenCalledTimes(1)
  })

  it('does not loop when the same address flips casing between reads', async () => {
    effectiveAddress.value = LOWERCASE
    const { useWallets } = await import('~/composables/useWallets')
    const { updateBalances } = useWallets()
    await flush()
    effectiveAddress.value = CHECKSUMMED
    await updateBalances()
    await flush()
    // Init fetch + direct call (+ at most one watcher-driven refresh from the
    // address flip) — the unbounded pre-fix loop produced a new fetch every
    // few milliseconds, far exceeding this bound within the flush window.
    expect(fetchWallet.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('caps follow-up refetches when needsFetch() can never settle', async () => {
    // A persistently failing fetch leaves lastFetchAddress null, so the
    // address condition in needsFetch() stays true after every run — the same
    // never-settling shape as the original casing bug.
    fetchWallet.mockImplementation(async () => {
      throw new Error('persistent fetch failure')
    })
    effectiveAddress.value = LOWERCASE
    const { useWallets } = await import('~/composables/useWallets')
    useWallets()
    await flush()
    await flush()

    const settled = fetchWallet.mock.calls.length
    // Initial run + capped follow-ups + at most a couple of watcher-driven
    // external triggers (which the cap intentionally still allows); without
    // the cap this grows unbounded within the flush window (the pre-fix loop
    // iterated every few ms).
    expect(settled).toBeGreaterThanOrEqual(2)
    expect(settled).toBeLessThanOrEqual(6)
    expect(logWarn).toHaveBeenCalledWith(
      'wallets/fetchBalances',
      expect.stringContaining('auto-refetch cap reached'),
      expect.anything(),
    )

    // And it stays stopped: no further fetches without an external trigger.
    await flush()
    expect(fetchWallet.mock.calls.length).toBe(settled)
  })
})
