import { ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { zeroAddress } from 'viem'
import axios from 'axios'
import { useTokenList } from '~/composables/useTokenList'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))
afterEach(() => vi.unstubAllGlobals())

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
