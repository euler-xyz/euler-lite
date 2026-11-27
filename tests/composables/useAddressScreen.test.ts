import { watch } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAddressScreen } from '~/composables/useAddressScreen'
import { isAddressExitOnly } from '~/composables/addressExitOnlyState'
import type { ScreeningVerdict } from '~/services/screening'

const { USER, OTHER, mocks } = vi.hoisted(() => ({
  USER: '0x0000000000000000000000000000000000000001',
  OTHER: '0x0000000000000000000000000000000000000002',
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

vi.mock('~/services/screening', () => ({
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
    let resolveScreening: (value: ScreeningVerdict) => void = () => {}
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockImplementation(() => new Promise<ScreeningVerdict>((resolve) => {
      resolveScreening = resolve
    }))

    const screening = useAddressScreen()
    const promise = screening.screenConnectedAddress(USER)

    expect(screening.isScreening.value).toBe(true)
    expect(screening.isAddressScreened(USER)).toBe(false)

    await Promise.resolve()
    expect(screening.isAddressScreened(USER)).toBe(false)

    resolveScreening('clear')
    await promise

    expect(screening.isScreening.value).toBe(false)
    expect(screening.isAddressScreened(USER)).toBe(true)
  })

  it.each([true, false, null])('disconnects restricted addresses regardless of VPN evidence (%s)', async (vpnIsUsed) => {
    mocks.detectVpn.mockResolvedValue(vpnIsUsed)
    mocks.screenAddress.mockResolvedValue('blocked')

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.modalOpen).toHaveBeenCalledTimes(1)
    expect(screening.isAddressScreened(USER)).toBe(false)
    expect(screening.isExitOnly.value).toBe(false)
  })

  it.each([true, false, null])('allows a screened address regardless of VPN evidence (%s)', async (vpnIsUsed) => {
    mocks.detectVpn.mockResolvedValue(vpnIsUsed)
    mocks.screenAddress.mockResolvedValue('clear')

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.screenAddress).toHaveBeenCalledWith(USER, vpnIsUsed)
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.modalOpen).not.toHaveBeenCalled()
    expect(screening.isAddressScreened(USER)).toBe(true)
    expect(screening.isExitOnly.value).toBe(false)
  })

  it('invalidates a pending verdict when screening state is reset', async () => {
    let resolveScreening: (value: ScreeningVerdict) => void = () => {}
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockImplementation(() => new Promise<ScreeningVerdict>((resolve) => {
      resolveScreening = resolve
    }))

    const screening = useAddressScreen()
    const promise = screening.screenConnectedAddress(USER)

    await Promise.resolve()
    screening.resetScreeningCache()
    resolveScreening('clear')
    await promise

    expect(screening.isScreening.value).toBe(false)
    expect(screening.isAddressScreened(USER)).toBe(false)
  })

  it('does not show a stale blocked modal if disconnect resets screening state', async () => {
    mocks.detectVpn.mockResolvedValue(false)
    mocks.screenAddress.mockResolvedValue('blocked')
    mocks.disconnect.mockImplementation(async () => {
      useAddressScreen().resetScreeningCache()
    })

    const screening = useAddressScreen()
    await screening.screenConnectedAddress(USER)

    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.modalOpen).not.toHaveBeenCalled()
    expect(screening.isAddressScreened(USER)).toBe(false)
  })

  describe('exit-only verdict', () => {
    const pendingVerdicts = () => {
      const resolvers: Array<(value: ScreeningVerdict) => void> = []
      mocks.screenAddress.mockImplementation(() => new Promise<ScreeningVerdict>((resolve) => {
        resolvers.push(resolve)
      }))
      return resolvers
    }

    beforeEach(() => {
      mocks.detectVpn.mockResolvedValue(false)
      mocks.disconnect.mockReset()
    })

    it('keeps the wallet connected with no blocked modal and raises the flag', async () => {
      mocks.screenAddress.mockResolvedValue('exit-only')

      const screening = useAddressScreen()
      await expect(screening.screenConnectedAddress(USER)).resolves.toBe(false)

      expect(mocks.disconnect).not.toHaveBeenCalled()
      expect(mocks.modalOpen).not.toHaveBeenCalled()
      expect(screening.isAddressScreened(USER)).toBe(true)
      expect(screening.isExitOnly.value).toBe(true)
      expect(isAddressExitOnly.value).toBe(true)
    })

    it('raises the flag before the address becomes visible', async () => {
      mocks.screenAddress.mockResolvedValue('exit-only')
      const screening = useAddressScreen()
      const flagWhenVisible: boolean[] = []
      const stop = watch(screening.screenedAddress, (address) => {
        if (address) flagWhenVisible.push(screening.isExitOnly.value)
      }, { flush: 'sync' })

      await screening.screenConnectedAddress(USER)
      stop()

      expect(flagWhenVisible).toEqual([true])
    })

    it('hides the address before it drops the flag when the next screening starts', async () => {
      mocks.screenAddress.mockResolvedValueOnce('exit-only')
      const screening = useAddressScreen()
      await screening.screenConnectedAddress(USER)

      const resolvers = pendingVerdicts()
      const visibleWhenFlagDropped: Array<string | null> = []
      const stop = watch(screening.isExitOnly, () => {
        visibleWhenFlagDropped.push(screening.screenedAddress.value)
      }, { flush: 'sync' })

      const promise = screening.screenConnectedAddress(OTHER)
      stop()
      expect(visibleWhenFlagDropped).toEqual([null])
      expect(screening.isExitOnly.value).toBe(false)

      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      resolvers[0]('clear')
      await promise
      expect(screening.isAddressScreened(OTHER)).toBe(true)
      expect(screening.isExitOnly.value).toBe(false)
    })

    it('does not let a stale answer raise the flag for a newer address', async () => {
      const resolvers = pendingVerdicts()
      const screening = useAddressScreen()

      const stale = screening.screenConnectedAddress(USER)
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      const current = screening.screenConnectedAddress(OTHER)
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))

      resolvers[0]('exit-only')
      await stale
      expect(screening.isExitOnly.value).toBe(false)
      expect(screening.isAddressScreened(USER)).toBe(false)

      resolvers[1]('clear')
      await current
      expect(screening.isExitOnly.value).toBe(false)
      expect(screening.isAddressScreened(OTHER)).toBe(true)
    })

    it('does not let an answer that arrives after a reset raise the flag', async () => {
      const resolvers = pendingVerdicts()
      const screening = useAddressScreen()

      const promise = screening.screenConnectedAddress(USER)
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      screening.resetScreeningCache()
      resolvers[0]('exit-only')
      await promise

      expect(screening.isExitOnly.value).toBe(false)
      expect(screening.isAddressScreened(USER)).toBe(false)
    })

    it('clears the flag on reset', async () => {
      mocks.screenAddress.mockResolvedValue('exit-only')
      const screening = useAddressScreen()
      await screening.screenConnectedAddress(USER)
      expect(screening.isExitOnly.value).toBe(true)

      screening.resetScreeningCache()

      expect(screening.isExitOnly.value).toBe(false)
      expect(screening.isAddressScreened(USER)).toBe(false)
    })
  })
})
