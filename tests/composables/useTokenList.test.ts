import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'
import axios from 'axios'
import { useTokenList } from '~/composables/useTokenList'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('canonicalizes an upstream native entry and preserves a zero-decimal ERC-20', async () => {
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
  const token = '0x0000000000000000000000000000000000000001'
  vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [
    { chainId: 1, address: zeroAddress, name: 'Bad native metadata', symbol: 'BAD', decimals: 6 },
    { chainId: 1, address: weth, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18 },
    { chainId: 1, address: token, name: 'Whole tokens', symbol: 'WHOLE', decimals: 0 },
  ] } })
  const list = useTokenList()
  await list.loadTokenList(true)
  expect(list.getTokenByAddress(zeroAddress)).toMatchObject({ decimals: 18, symbol: 'ETH' })
  expect(list.getTokenByAddress(token)).toMatchObject({ decimals: 0 })
})

it.each([false, true])('clears shared metadata during a replacement fetch and after failure, forced=%s', async (forceRefresh) => {
  vi.useFakeTimers()
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  const token = { chainId: 1, address: '0x0000000000000000000000000000000000000001', name: 'Token', symbol: 'TOK', decimals: 18 }
  const list = useTokenList()
  vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [token] } })
  await list.loadTokenList(true)
  if (!forceRefresh) await vi.advanceTimersByTimeAsync(300_001)

  let fail!: (reason: Error) => void
  vi.mocked(axios.get).mockImplementationOnce(() => new Promise((_resolve, reject) => {
    fail = reject
  }))
  const refresh = list.loadTokenList(forceRefresh)
  expect(list.getAllTokens()).toEqual([])
  expect(list.hasToken(token.address)).toBe(false)
  expect(list.getTokenByAddress(token.address)).toBeUndefined()
  expect(list.isLoading.value).toBe(true)
  fail(new Error('502: contract decimals unavailable'))
  await refresh
  expect(list.getAllTokens()).toEqual([])
  expect(list.isLoaded.value).toBe(false)
  expect(list.isLoading.value).toBe(false)

  vi.mocked(axios.get).mockResolvedValueOnce({ data: { tokens: [{ ...token, decimals: 17 }] } })
  await list.loadTokenList()
  expect(list.getTokenByAddress(token.address)?.decimals).toBe(17)
  expect(list.isLoaded.value).toBe(true)
})

it('does not let an older failure finish a newer chain refresh', async () => {
  const chainId = ref(1)
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  const list = useTokenList()
  let rejectOld!: (reason: Error) => void
  vi.mocked(axios.get).mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectOld = reject
  }))
  const older = list.loadTokenList(true)
  chainId.value = 43114
  let finishNew!: (value: unknown) => void
  vi.mocked(axios.get).mockImplementationOnce(() => new Promise((resolve) => {
    finishNew = resolve
  }))
  const newer = list.loadTokenList(true)
  rejectOld(new Error('Old chain failed'))
  await older
  expect(list.isLoading.value).toBe(true)
  const token = { chainId: 43114, address: '0xbBAAA0420D474B34Be197f95A323C2fF3829E811', symbol: 'LODE', name: 'Lode', decimals: 17 }
  finishNew({ data: { tokens: [token] } })
  await newer
  expect(list.getAllTokens()).toEqual([token])
  expect(list.isLoading.value).toBe(false)
  expect(list.isLoaded.value).toBe(true)
})
