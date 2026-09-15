import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicGeoPolicy, PublicLabelsRequest } from '@eulerxyz/euler-v2-sdk/public-labels'
import { createGeoPolicySource } from '~/server/utils/geo-policy-source'

vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))
const policy: PublicGeoPolicy = { id: 'global', chainId: null, productId: null, vaultAddress: null, assetAddress: null, countries: ['US'], countriesResolved: ['US'], policyType: 'block', reason: null, createdAt: '' }
const requestFor = (policies: PublicGeoPolicy[]) => vi.fn(async () => ({ data: policies, meta: { total: policies.length } })) as unknown as PublicLabelsRequest

describe('durable geo source', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'geo-test-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  it('retains policies across restarts and unbounded outages; successful empty clears them', async () => {
    const first = await createGeoPolicySource('v3', directory)(requestFor([policy]))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 365 * 86400_000)
    const restarted = createGeoPolicySource('v3', directory)
    const offline = vi.fn().mockRejectedValue(new Error('offline')) as PublicLabelsRequest
    expect(await restarted(offline)).toEqual(first)
    expect(await restarted(requestFor([]))).toEqual({ fetchedAt: Date.now(), policies: [] })
  })

  it('isolates upstream identities and rejects unavailable cold starts', async () => {
    await createGeoPolicySource('v3-a', directory)(requestFor([policy]))
    const offline = vi.fn().mockRejectedValue(new Error('offline')) as PublicLabelsRequest
    await expect(createGeoPolicySource('v3-b', directory)(offline)).rejects.toThrow('offline')
  })

  it('never replaces the checkpoint with malformed or partially fetched policies', async () => {
    const first = await createGeoPolicySource('v3', directory)(requestFor([policy]))
    const invalid = requestFor([{ ...policy, countriesResolved: undefined } as unknown as PublicGeoPolicy])
    expect(await createGeoPolicySource('v3', directory)(invalid)).toEqual(first)
    const partial = vi.fn().mockResolvedValueOnce({ data: [policy], meta: { total: 2 } }).mockRejectedValueOnce(new Error('page two failed')) as PublicLabelsRequest
    expect(await createGeoPolicySource('v3', directory)(partial)).toEqual(first)
  })
})
