import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddressScreen } from '~/composables/useAddressScreen'

const { USER, mocks } = vi.hoisted(() => ({
  USER: '0x0000000000000000000000000000000000000001',
  mocks: {
    detectVpn: vi.fn(),
    disconnect: vi.fn(),
    modalClose: vi.fn(),
    modalOpen: vi.fn(),
    resetCountryCache: vi.fn(),
    resetVpnCache: vi.fn(),
    routerPush: vi.fn(),
    screenAddress: vi.fn(),
  },
}))

vi.mock('@wagmi/vue', () => ({
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
}))

vi.mock('#components', () => ({
  BlockedAddressModal: {},
}))

vi.mock('~/components/ui/composables/useModal', () => ({
  useModal: () => ({
    close: mocks.modalClose,
    open: mocks.modalOpen,
  }),
}))

vi.mock('~/services/country', () => ({
  resetCountryCache: mocks.resetCountryCache,
}))

vi.mock('~/services/vpn', () => ({
  detectVpn: mocks.detectVpn,
  resetVpnCache: mocks.resetVpnCache,
}))

vi.mock('~/services/trm', () => ({
  screenAddress: mocks.screenAddress,
}))

describe('useAddressScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useRouter', () => ({ push: mocks.routerPush }))
    vi.stubGlobal('useDeployConfig', () => ({
      enableEarnPage: true,
      enableExplorePage: true,
      enableLendPage: true,
    }))

    useAddressScreen().resetScreeningCache()
    vi.clearAllMocks()
  })

  it('keeps an address unscreened while the verdict is pending', async () => {
    let resolveScreening: (value: boolean) => void = () => {}
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveScreening = resolve
    }))

    const screening = useAddressScreen()
    const promise = screening.screenConnectedAddress(USER)

    expect(screening.isScreening.value).toBe(true)
    expect(screening.isAddressScreened(USER)).toBe(false)

    await Promise.resolve()
    expect(screening.isAddressScreened(USER)).toBe(false)

    resolveScreening(false)
    await promise

    expect(screening.isScreening.value).toBe(false)
    expect(screening.isAddressScreened(USER)).toBe(true)
  })

  it('disconnects restricted addresses without marking them screened', async () => {
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockResolvedValue(true)

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.modalOpen).toHaveBeenCalledTimes(1)
    expect(screening.isAddressScreened(USER)).toBe(false)
  })

  it('disconnects fail-closed VPN detections without marking them screened', async () => {
    mocks.detectVpn.mockResolvedValue(true)
    mocks.screenAddress.mockResolvedValue(false)

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.screenAddress).toHaveBeenCalledWith(USER, true)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.modalOpen).toHaveBeenCalledTimes(1)
    expect(screening.isAddressScreened(USER)).toBe(false)
  })

  it('invalidates a pending verdict when screening state is reset', async () => {
    let resolveScreening: (value: boolean) => void = () => {}
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveScreening = resolve
    }))

    const screening = useAddressScreen()
    const promise = screening.screenConnectedAddress(USER)

    await Promise.resolve()
    screening.resetScreeningCache()
    resolveScreening(false)
    await promise

    expect(screening.isScreening.value).toBe(false)
    expect(screening.isAddressScreened(USER)).toBe(false)
  })

  it('does not show a stale blocked modal if disconnect resets screening state', async () => {
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockResolvedValue(true)
    mocks.disconnect.mockImplementation(async () => {
      useAddressScreen().resetScreeningCache()
    })

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.modalOpen).not.toHaveBeenCalled()
    expect(screening.isAddressScreened(USER)).toBe(false)
  })
})
