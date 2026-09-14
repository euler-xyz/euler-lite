import { describe, expect, it, vi } from 'vitest'
import { EulerLabelsService } from '@eulerxyz/euler-v2-sdk'
import { fetchEulerLabelsDataStrict } from '~/utils/euler-labels-fetch'

const VAULT = '0x00000000000000000000000000000000000000A1'
const createService = () => new EulerLabelsService({
  fetchEulerLabelsEntities: async () => ({}),
  fetchEulerLabelsProducts: async () => ({}),
  fetchEulerLabelsEarnVaults: async () => [VAULT],
  fetchEulerLabelsPoints: async () => [],
  fetchEulerLabelsAssets: async () => [],
})

describe('verification label fetching', () => {
  it.each(['fetchEulerLabelsEntities', 'fetchEulerLabelsProducts', 'fetchEulerLabelsEarnVaults'] as const)(
    'propagates %s failure instead of normalizing an empty result',
    async (method) => {
      const service = createService()
      vi.spyOn(service, method).mockRejectedValue(new Error('upstream unavailable'))
      await expect(fetchEulerLabelsDataStrict(service, 143)).rejects.toThrow('upstream unavailable')
    },
  )

  it('keeps SDK normalization and accepts a successfully empty label list', async () => {
    const service = createService()
    expect((await fetchEulerLabelsDataStrict(service, 143)).earnVaults).toHaveLength(1)
    vi.spyOn(service, 'fetchEulerLabelsEarnVaults').mockResolvedValue([])
    expect((await fetchEulerLabelsDataStrict(service, 143)).earnVaults).toEqual([])
  })

  it('does not require optional point-reward labels for verification', async () => {
    const service = createService()
    vi.spyOn(service, 'fetchEulerLabelsPoints').mockRejectedValue(new Error('points unavailable'))
    expect((await fetchEulerLabelsDataStrict(service, 143)).earnVaults).toHaveLength(1)
  })
})
