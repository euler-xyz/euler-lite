import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

/**
 * useWagmi exposes the connector address in EIP-55 checksummed form.
 *
 * Connectors are not guaranteed to report checksummed casing — AppKit's
 * WalletConnect connector passes the wallet's session string through
 * verbatim, and wallets may emit lowercase. Normalizing at this choke point
 * gives every consumer canonical casing (raw-casing comparisons against this
 * value previously caused the balance refetch loop fixed in useWallets).
 */

const CHECKSUMMED = '0x904788be730704B53B55E0654A9D659B3A9ce0a7'
const LOWERCASE = CHECKSUMMED.toLowerCase() as Address
const OTHER = '0x9Db3e0FBd969ec2468C8d9f85440dC5595CE1FD9' as Address

const wagmiAddress = ref<Address | undefined>(undefined)
const wagmiIsConnected = ref(false)
const wagmiChain = ref<{ id: number } | undefined>(undefined)

const screening = vi.hoisted(() => ({
  useRealScreen: false,
  disconnect: vi.fn(),
  modalOpen: vi.fn(),
  screenAddress: vi.fn(),
}))

vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({
    address: wagmiAddress,
    isConnected: wagmiIsConnected,
    connector: ref(undefined),
    chain: wagmiChain,
    status: ref('disconnected'),
  }),
  useDisconnect: () => ({ disconnect: screening.disconnect }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useEnsName: () => ({ data: ref(undefined) }),
  useConfig: () => ({}),
}))
vi.mock('@wagmi/vue/actions', () => ({
  connect: vi.fn(),
  getConnectors: () => [],
}))
vi.mock('~/composables/useAddressScreen', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/composables/useAddressScreen')>()
  return {
    useAddressScreen: () => screening.useRealScreen
      ? real.useAddressScreen()
      : {
          screenConnectedAddress: vi.fn(async () => false),
          resetScreeningCache: vi.fn(),
          isAddressScreened: (address?: string | null) => Boolean(address),
        },
  }
})
vi.mock('#components', () => ({ BlockedAddressModal: {} }))
vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({ open: screening.modalOpen, close: vi.fn() }),
}))
vi.mock('~/services/screening', () => ({ screenAddress: screening.screenAddress }))
vi.mock('~/services/vpn', () => ({ detectVpn: vi.fn(async () => null), resetVpnCache: vi.fn() }))
vi.mock('~/services/country', () => ({ resetCountryCache: vi.fn() }))

// The real useAddressScreen is imported through the mock factory, so the first import in each describe is slow under load.
describe('useWagmi address casing', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal('useRoute', () => ({ path: '/', query: {}, hash: '' }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => {}), push: vi.fn(async () => {}) }))
    vi.stubGlobal('useEulerAddresses', () => ({
      changeCurrentChainId: vi.fn(),
      chainId: ref(1),
      allowedChainIds: computed(() => [1]),
    }))
    vi.stubGlobal('useNuxtApp', () => ({}))
  })

  it('exposes a lowercase connector address in checksummed form', async () => {
    const { useWagmi } = await import('~/composables/useWagmi')
    const { address, checksummedAddress } = useWagmi()

    wagmiAddress.value = LOWERCASE
    wagmiIsConnected.value = true

    expect(address.value).toBe(CHECKSUMMED)
    expect(checksummedAddress.value).toBe(CHECKSUMMED)
  })

  it('leaves an already-checksummed connector address unchanged', async () => {
    const { useWagmi } = await import('~/composables/useWagmi')
    const { address } = useWagmi()

    wagmiAddress.value = CHECKSUMMED as Address

    expect(address.value).toBe(CHECKSUMMED)
  })

  it('stays undefined when no address is connected', async () => {
    const { useWagmi } = await import('~/composables/useWagmi')
    const { address, checksummedAddress } = useWagmi()

    wagmiAddress.value = undefined

    expect(address.value).toBeUndefined()
    expect(checksummedAddress.value).toBe('')
  })
})

describe('useWagmi screening gate', { timeout: 30_000 }, () => {
  const connect = async () => {
    vi.resetModules()
    screening.useRealScreen = true
    vi.stubGlobal('useRoute', () => ({ path: '/', query: {}, hash: '' }))
    vi.stubGlobal('useRouter', () => ({ replace: vi.fn(async () => {}), push: vi.fn(async () => {}) }))
    vi.stubGlobal('useEulerAddresses', () => ({
      changeCurrentChainId: vi.fn(),
      chainId: ref(1),
      allowedChainIds: computed(() => [1]),
    }))
    vi.stubGlobal('useNuxtApp', () => ({}))
    vi.stubGlobal('useDeployConfig', () => ({ enableEarnPage: true, enableExplorePage: true, enableLendPage: true }))

    const { useWagmi } = await import('~/composables/useWagmi')
    const { useAddressScreen } = await import('~/composables/useAddressScreen')
    wagmiAddress.value = undefined
    wagmiIsConnected.value = false
    const wagmi = useWagmi()
    wagmiAddress.value = LOWERCASE
    wagmiIsConnected.value = true
    return { wagmi, addressScreen: useAddressScreen() }
  }

  beforeEach(() => {
    screening.disconnect.mockReset()
    screening.modalOpen.mockReset()
    screening.screenAddress.mockReset()
  })

  afterEach(() => {
    screening.useRealScreen = false
    wagmiAddress.value = undefined
    wagmiIsConnected.value = false
    vi.resetModules()
  })

  it('exposes an exit-only address, with the flag up and no disconnect or blocked modal', async () => {
    screening.screenAddress.mockResolvedValue('exit-only')
    const { wagmi, addressScreen } = await connect()

    await vi.waitFor(() => expect(wagmi.address.value).toBe(CHECKSUMMED))

    expect(wagmi.isConnected.value).toBe(true)
    expect(addressScreen.isExitOnly.value).toBe(true)
    expect(screening.disconnect).not.toHaveBeenCalled()
    expect(screening.modalOpen).not.toHaveBeenCalled()
  })

  it('drops the flag and hides the address when the wallet disconnects', async () => {
    screening.screenAddress.mockResolvedValue('exit-only')
    const { wagmi, addressScreen } = await connect()
    await vi.waitFor(() => expect(addressScreen.isExitOnly.value).toBe(true))

    wagmiAddress.value = undefined
    wagmiIsConnected.value = false

    await vi.waitFor(() => expect(addressScreen.isExitOnly.value).toBe(false))
    expect(wagmi.address.value).toBeUndefined()
    expect(wagmi.isConnected.value).toBe(false)
  })

  it('drops the flag when the wallet switches to a clear address', async () => {
    screening.screenAddress.mockResolvedValueOnce('exit-only').mockResolvedValueOnce('clear')
    const { wagmi, addressScreen } = await connect()
    await vi.waitFor(() => expect(addressScreen.isExitOnly.value).toBe(true))

    wagmiAddress.value = OTHER

    await vi.waitFor(() => expect(wagmi.address.value).toBe(OTHER))
    expect(addressScreen.isExitOnly.value).toBe(false)
  })

  it('hides a blocked address and disconnects it, as before', async () => {
    screening.screenAddress.mockResolvedValue('blocked')
    const { wagmi, addressScreen } = await connect()

    await vi.waitFor(() => expect(screening.modalOpen).toHaveBeenCalledTimes(1))

    expect(wagmi.address.value).toBeUndefined()
    expect(wagmi.isConnected.value).toBe(false)
    expect(addressScreen.isExitOnly.value).toBe(false)
    expect(screening.disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps the address hidden while the verdict is pending', async () => {
    screening.screenAddress.mockImplementation(() => new Promise(() => {}))
    const { wagmi } = await connect()

    await vi.waitFor(() => expect(screening.screenAddress).toHaveBeenCalled())

    expect(wagmi.address.value).toBeUndefined()
    expect(wagmi.isConnected.value).toBe(false)
  })
})
