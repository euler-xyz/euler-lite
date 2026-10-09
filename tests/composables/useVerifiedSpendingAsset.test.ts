import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatUnits, getAddress, parseUnits, zeroAddress, type Address } from 'viem'
import type { VaultAsset } from '~/types/asset'
import { useVerifiedSpendingAsset as createState } from '~/composables/useVerifiedSpendingAsset'

const { resolveTokenDecimals, sdkForChain } = vi.hoisted(() => ({
  resolveTokenDecimals: vi.fn(),
  sdkForChain: vi.fn(),
}))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkForChain: sdkForChain }))

const scopes: ReturnType<typeof effectScope>[] = []
const useVerifiedSpendingAsset = (invalidate?: () => void) => {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => createState(invalidate))!
}
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

const token: VaultAsset = { address: '0x00000000000000000000000000000000000000ab', name: 'Selected token', symbol: 'SEL', decimals: 18 }
const other: VaultAsset = { ...token, address: '0x00000000000000000000000000000000000000cd' }
const chainId = ref(1)
const settle = async () => {
  for (let i = 0; i < 12; i++) await nextTick()
}
const deferred = () => {
  let resolve!: (value: number) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<number>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  chainId.value = 1
  resolveTokenDecimals.mockReset().mockResolvedValue(17)
  sdkForChain.mockReset().mockImplementation(async () => ({ tokenlistService: { resolveTokenDecimals } }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
})

describe('selected spending asset decimals', () => {
  it('verifies a default wallet asset and preserves an explicit pay-with choice across vault changes', async () => {
    const state = useVerifiedSpendingAsset()
    state.setDefaultAsset(token)
    expect(state.isBlocked.value).toBe(true)
    expect(state.asset.value).toBeUndefined()
    await settle()
    expect(state.asset.value?.decimals).toBe(17)

    state.asset.value = other
    await settle()
    state.setDefaultAsset({ ...token, address: '0x00000000000000000000000000000000000000ef' })
    await settle()
    expect(state.asset.value?.address).toBe(other.address)
    expect(resolveTokenDecimals).toHaveBeenCalledTimes(2)
  })

  it('does no reads until a spending token is selected; corrects only the local selection', async () => {
    const state = useVerifiedSpendingAsset()
    expect(sdkForChain).not.toHaveBeenCalled()
    state.asset.value = token
    expect(state.asset.value).toBeUndefined()
    expect(state.isBlocked.value).toBe(true)
    await settle()
    expect(state.asset.value).toEqual({ ...token, decimals: 17 })
    expect(token.decimals).toBe(18)
    expect(state.isBlocked.value).toBe(false)
    expect(sdkForChain).toHaveBeenCalledWith(1)
    expect(resolveTokenDecimals).toHaveBeenCalledWith(1, expect.stringMatching(/^0x[\da-fA-F]{40}$/))
    expect(resolveTokenDecimals.mock.calls[0]![1].toLowerCase()).toBe(token.address)
  })

  it.each([17, 8, 0])('uses verified %i decimals for typed amount, Max, and review round trips', async (decimals) => {
    resolveTokenDecimals.mockResolvedValue(decimals)
    const state = useVerifiedSpendingAsset()
    state.asset.value = token
    await settle()
    const asset = state.asset.value!
    const typed = parseUnits('2', asset.decimals)
    expect(typed).toBe(2n * 10n ** BigInt(decimals))
    const balance = 31n * 10n ** BigInt(decimals)
    const max = formatUnits(balance, asset.decimals)
    expect(max).toBe('31')
    expect(parseUnits(max, asset.decimals)).toBe(balance)
    expect(formatUnits(typed, asset.decimals)).toBe('2')
  })

  it('passes the selected chain and normalized address to the SDK on each selection', async () => {
    const state = useVerifiedSpendingAsset()
    state.asset.value = { ...token, address: token.address.toUpperCase().replace('0X', '0x') as Address }
    await settle()
    expect(resolveTokenDecimals.mock.calls[0]![1].toLowerCase()).toBe(token.address)
    state.asset.value = token
    await settle()
    expect(resolveTokenDecimals).toHaveBeenCalledTimes(2)
    chainId.value = 10
    expect(state.asset.value).toBeUndefined()
    await settle()
    expect(sdkForChain).not.toHaveBeenCalledWith(10)
    state.asset.value = token
    await settle()
    expect(sdkForChain).toHaveBeenLastCalledWith(10)
    expect(resolveTokenDecimals).toHaveBeenLastCalledWith(10, expect.any(String))
  })

  it('clears an explicit pay-with choice on chain change and seeds the new default', async () => {
    const state = useVerifiedSpendingAsset()
    state.setDefaultAsset(token)
    await settle()
    state.asset.value = other
    await settle()
    const readsOnFirstChain = resolveTokenDecimals.mock.calls.length

    chainId.value = 10
    expect(state.asset.value).toBeUndefined()
    expect(state.isBlocked.value).toBe(false)
    await settle()
    expect(resolveTokenDecimals).toHaveBeenCalledTimes(readsOnFirstChain)

    const nextDefault = { ...token, address: '0x00000000000000000000000000000000000000ef' as Address }
    state.setDefaultAsset(nextDefault)
    expect(state.isBlocked.value).toBe(true)
    await settle()
    expect(state.asset.value).toEqual({ ...nextDefault, decimals: 17 })
    expect(resolveTokenDecimals).toHaveBeenLastCalledWith(10, getAddress(nextDefault.address))
  })

  it('blocks failures without a list fallback and explicitly retries', async () => {
    resolveTokenDecimals.mockRejectedValueOnce(new Error('Unavailable'))
    const state = useVerifiedSpendingAsset()
    state.asset.value = token
    await settle()
    expect(state.asset.value).toBeUndefined()
    expect(state.isBlocked.value).toBe(true)
    expect(state.error.value).toBeTruthy()
    await state.retry()
    expect(resolveTokenDecimals).toHaveBeenCalledTimes(2)
    expect(state.asset.value?.decimals).toBe(17)
    expect(state.error.value).toBeNull()
  })

  it('blocks when a custom SDK token-list override has no decimals resolver', async () => {
    sdkForChain.mockResolvedValueOnce({ tokenlistService: {} })
    const state = useVerifiedSpendingAsset()
    state.asset.value = token
    await settle()
    expect(state.asset.value).toBeUndefined()
    expect(state.isBlocked.value).toBe(true)
    expect(state.error.value).toBeTruthy()
    await state.retry()
    expect(state.asset.value?.decimals).toBe(17)
  })

  it.each([undefined, -1, 256, 1.5, '18'])('blocks an invalid resolver result %s', async (result) => {
    resolveTokenDecimals.mockResolvedValue(result)
    const state = useVerifiedSpendingAsset()
    state.asset.value = token
    await settle()
    expect(state.asset.value).toBeUndefined()
    expect(state.isBlocked.value).toBe(true)
    expect(state.error.value).toBeTruthy()
  })

  it('ignores stale token and chain responses and invalidates dependent state synchronously', async () => {
    const first = deferred()
    const second = deferred()
    resolveTokenDecimals.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const invalidate = vi.fn()
    const state = useVerifiedSpendingAsset(invalidate)
    state.asset.value = token
    state.asset.value = other
    expect(invalidate).toHaveBeenCalledTimes(2)
    first.resolve(8)
    await settle()
    expect(state.asset.value).toBeUndefined()
    chainId.value = 10
    expect(invalidate).toHaveBeenCalledTimes(3)
    await settle()
    expect(state.asset.value).toBeUndefined()
    second.resolve(6)
    await settle()
    expect(state.asset.value).toBeUndefined()
  })

  it('clearing selection or disposing invalidates an outstanding read', async () => {
    const pending = deferred()
    resolveTokenDecimals.mockReturnValueOnce(pending.promise)
    const scope = effectScope()
    const state = scope.run(() => useVerifiedSpendingAsset())!
    state.asset.value = token
    scope.stop()
    pending.resolve(8)
    await settle()
    expect(state.asset.value).toBeUndefined()
    state.asset.value = undefined
    expect(state.isBlocked.value).toBe(false)
  })

  it('bypasses ERC20 reads for native currency', () => {
    const state = useVerifiedSpendingAsset()
    state.asset.value = { ...token, address: zeroAddress }
    expect(state.asset.value?.decimals).toBe(18)
    expect(state.isBlocked.value).toBe(false)
    expect(sdkForChain).not.toHaveBeenCalled()
  })
})
