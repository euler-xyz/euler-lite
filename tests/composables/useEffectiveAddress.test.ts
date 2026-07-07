import { computed, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffectiveAddress } from '~/composables/useEffectiveAddress'

const WALLET = '0x0000000000000000000000000000000000000001'
const SPY = '0x0000000000000000000000000000000000000002'

describe('useEffectiveAddress', () => {
  const address = ref<string | undefined>(WALLET)
  const isConnected = ref(true)
  const isSpyMode = ref(false)
  const spyAddress = ref<string | undefined>(undefined)

  beforeEach(() => {
    address.value = WALLET
    isConnected.value = true
    isSpyMode.value = false
    spyAddress.value = undefined

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useWagmi', () => ({ address, isConnected }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode, spyAddress }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves to the connected wallet address outside spy mode', () => {
    const { effectiveAddress } = useEffectiveAddress()
    expect(effectiveAddress.value).toBe(WALLET)
  })

  it('resolves to the spied address in spy mode', () => {
    isSpyMode.value = true
    spyAddress.value = SPY
    const { effectiveAddress } = useEffectiveAddress()
    expect(effectiveAddress.value).toBe(SPY)
  })

  it('tracks spy mode toggles reactively', () => {
    spyAddress.value = SPY
    const { effectiveAddress } = useEffectiveAddress()
    expect(effectiveAddress.value).toBe(WALLET)
    isSpyMode.value = true
    expect(effectiveAddress.value).toBe(SPY)
    isSpyMode.value = false
    expect(effectiveAddress.value).toBe(WALLET)
  })

  it('is undefined in spy mode when no spy address is set', () => {
    isSpyMode.value = true
    const { effectiveAddress } = useEffectiveAddress()
    expect(effectiveAddress.value).toBeUndefined()
  })

  it('re-exports the underlying wagmi and spy-mode values', () => {
    const result = useEffectiveAddress()
    expect(result.address).toBe(address)
    expect(result.isConnected).toBe(isConnected)
    expect(result.isSpyMode).toBe(isSpyMode)
    expect(result.spyAddress).toBe(spyAddress)
  })
})
