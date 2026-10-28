import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const wagmiAddress = ref<Address | undefined>(undefined)
const wagmiIsConnected = ref(false)
const wagmiChain = ref<{ id: number } | undefined>(undefined)

vi.mock('@wagmi/vue', () => ({
  useAccount: () => ({
    address: wagmiAddress,
    isConnected: wagmiIsConnected,
    connector: ref(undefined),
    chain: wagmiChain,
    status: ref('disconnected'),
  }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn() }),
  useEnsName: () => ({ data: ref(undefined) }),
  useConfig: () => ({}),
}))
vi.mock('@wagmi/vue/actions', () => ({
  connect: vi.fn(),
  getConnectors: () => [],
}))
vi.mock('~/composables/useAddressScreen', () => ({
  useAddressScreen: () => ({
    screenConnectedAddress: vi.fn(async () => false),
    resetScreeningCache: vi.fn(),
    isAddressScreened: (address?: string | null) => Boolean(address),
  }),
}))

describe('useWagmi address casing', () => {
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
