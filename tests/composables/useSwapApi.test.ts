import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useSwapApi } from '~/composables/useSwapApi'

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}))

describe('useSwapApi', () => {
  const axiosGet = vi.mocked(axios.get)

  beforeEach(() => {
    axiosGet.mockReset()

    vi.stubGlobal('useEulerConfig', () => ({
      SWAP_API_URL: 'https://swap.example.test',
    }))
    vi.stubGlobal('useEulerAddresses', () => ({
      chainId: ref(1),
    }))
    vi.stubGlobal('useWagmi', () => ({
      address: ref('0x0000000000000000000000000000000000000001'),
    }))
  })

  it('filters CoW provider aliases unless CoW swaps are explicitly included', async () => {
    axiosGet.mockResolvedValue({
      data: {
        success: true,
        data: ['cow', 'CoW Swap', 'other'],
      },
    })

    await expect(useSwapApi().getSwapProviders()).resolves.toEqual(['other'])
    await expect(useSwapApi().getSwapProviders({ includeCowSwap: true })).resolves.toEqual(['cow', 'CoW Swap', 'other'])
  })
})
