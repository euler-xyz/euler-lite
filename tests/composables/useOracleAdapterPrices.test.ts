import { computed, effectScope, nextTick, ref, shallowRef, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, type Hex } from 'viem'
import type { EVault, OracleRouteStep } from '@eulerxyz/euler-v2-sdk'
import { priceOracleAbi } from '~/abis/oracle'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import type { BatchItemResult } from '~/abis/evc'
import { getOracleRouteStepKey, useOracleAdapterPrices } from '~/composables/useOracleAdapterPrices'

const { evcBatchCall, getEulerSdkForChain, buildPythBatchItemsFromFeeds } = vi.hoisted(() => ({
  evcBatchCall: vi.fn(),
  getEulerSdkForChain: vi.fn(),
  buildPythBatchItemsFromFeeds: vi.fn(),
}))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkForChain }))
vi.mock('~/utils/multicall', async importOriginal => ({
  ...await importOriginal<typeof import('~/utils/multicall')>(),
  evcBatchCall,
}))
vi.mock('~/utils/pyth', () => ({ buildPythBatchItemsFromFeeds }))
vi.mock('~/utils/errorHandling', () => ({ logWarn: vi.fn() }))

const ADAPTER = '0x0000000000000000000000000000000000000001'
const BASE = '0x0000000000000000000000000000000000000002'
const QUOTE = '0x0000000000000000000000000000000000000003'
const VAULT = '0x0000000000000000000000000000000000000004'
const EVC = '0x0000000000000000000000000000000000000005'
const UNKNOWN = '0x0000000000000000000000000000000000000006'
const step: OracleRouteStep = { kind: 'adapter', oracle: ADAPTER, base: BASE, quote: QUOTE, name: 'Unverified name' }
const chainId = ref(1)
const steps = ref<OracleRouteStep[]>([step])
const sourceVaults = shallowRef<EVault[]>([{
  address: VAULT,
  asset: { address: BASE, decimals: 6 },
  shares: { decimals: 8 },
  unitOfAccount: { address: QUOTE, decimals: 18 },
} as unknown as EVault])
const scopes: EffectScope[] = []
const result = (value: bigint): BatchItemResult[] => [{
  success: true,
  result: encodeAbiParameters([{ type: 'uint256' }], [value]),
}]

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const start = () => {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useOracleAdapterPrices(
    computed(() => steps.value),
    computed(() => sourceVaults.value),
    computed(() => []),
  ))!
}
const settle = async () => {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.resetAllMocks()
  chainId.value = 1
  steps.value = [step]
  getEulerSdkForChain.mockImplementation(async (id: number) => ({
    providerService: { getProvider: () => ({ chainId: id }) },
  }))
  buildPythBatchItemsFromFeeds.mockResolvedValue({ items: [], totalFee: 0n })
  evcBatchCall.mockResolvedValue(result(25n * 10n ** 18n))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId, eulerCoreAddresses: ref({ evc: EVC }) }))
  vi.stubGlobal('useEulerConfig', () => ({ PYTH_HERMES_URL: 'proxy' }))
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

describe('oracle route RPC quotes', () => {
  it('quotes one base token in the routed direction using its actual decimals', async () => {
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    const items = evcBatchCall.mock.calls[0][2]
    expect(decodeFunctionData({ abi: priceOracleAbi, data: items[0].data as Hex })).toMatchObject({
      functionName: 'getQuote', args: [1_000_000n, BASE, QUOTE],
    })
    expect(state.prices.value.get(getOracleRouteStepKey(step))).toEqual({ success: true, rate: 25 })
    expect(getEulerSdkForChain).toHaveBeenCalledWith(1)
  })

  it('quotes ERC4626 steps through convertToAssets with share decimals', async () => {
    const vaultStep: OracleRouteStep = {
      kind: 'vault', oracle: VAULT, base: VAULT, quote: BASE,
      name: 'ERC4626Vault', vault: VAULT, asset: BASE,
    }
    steps.value = [vaultStep]
    evcBatchCall.mockResolvedValue(result(1_250_000n))
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(decodeFunctionData({ abi: vaultConvertToAssetsAbi, data: evcBatchCall.mock.calls[0][2][0].data })).toMatchObject({
      functionName: 'convertToAssets', args: [100_000_000n],
    })
    expect(state.prices.value.get(getOracleRouteStepKey(vaultStep))).toEqual({ success: true, rate: 1.25 })
  })

  it.each([
    { name: 'reverted', results: [{ success: false, result: '0x' }] },
    { name: 'malformed', results: [{ success: true, result: '0x12' }] },
  ])('omits quotes with $name decimal reads rather than assuming 18', async ({ results }) => {
    steps.value = [{ ...step, quote: UNKNOWN }]
    evcBatchCall.mockResolvedValueOnce(results).mockResolvedValue([])
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(state.prices.value.size).toBe(0)
    expect(evcBatchCall).toHaveBeenCalledTimes(1)
  })

  it('uses successfully read decimals for an intermediate route token', async () => {
    const unknownStep: OracleRouteStep = { ...step, quote: UNKNOWN }
    steps.value = [unknownStep]
    evcBatchCall
      .mockResolvedValueOnce(result(6n))
      .mockResolvedValueOnce(result(2_500_000n))
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(state.prices.value.get(getOracleRouteStepKey(unknownStep))).toEqual({ success: true, rate: 2.5 })
  })

  it('retains successful zero quotes and distinguishes failed calls', async () => {
    evcBatchCall.mockResolvedValue(result(0n))
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(state.prices.value.get(getOracleRouteStepKey(step))).toEqual({ success: true, rate: 0 })
    evcBatchCall.mockResolvedValue([{ success: false, result: '0x' }])
    steps.value = [{ ...step }]
    await settle()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(state.prices.value.get(getOracleRouteStepKey(step))).toEqual({ success: false, rate: 0 })
  })

  it('leaves quotes unavailable after a transport failure', async () => {
    evcBatchCall.mockRejectedValue(new Error('RPC unavailable'))
    const state = start()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    expect(state.prices.value.size).toBe(0)
  })

  it('ignores an obsolete route response after a new route succeeds', async () => {
    const oldRequest = deferred<BatchItemResult[]>()
    evcBatchCall.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(result(42n * 10n ** 18n))
    const state = start()
    await vi.waitFor(() => expect(evcBatchCall).toHaveBeenCalledTimes(1))
    const nextStep: OracleRouteStep = { ...step, oracle: UNKNOWN }
    steps.value = [nextStep]
    await settle()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    oldRequest.resolve(result(25n * 10n ** 18n))
    await settle()
    expect([...state.prices.value.keys()]).toEqual([getOracleRouteStepKey(nextStep)])
    expect(state.prices.value.get(getOracleRouteStepKey(nextStep))?.rate).toBe(42)
  })

  it('discards a previous chain quote even when its route addresses are identical', async () => {
    const oldRequest = deferred<BatchItemResult[]>()
    evcBatchCall.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(result(42n * 10n ** 18n))
    const state = start()
    await vi.waitFor(() => expect(evcBatchCall).toHaveBeenCalledTimes(1))
    chainId.value = 56
    await settle()
    await vi.waitFor(() => expect(state.isLoading.value).toBe(false))
    oldRequest.resolve(result(25n * 10n ** 18n))
    await settle()
    expect(getEulerSdkForChain).toHaveBeenLastCalledWith(56)
    expect(evcBatchCall.mock.calls[1][0]).toEqual({ chainId: 56 })
    expect(state.prices.value.get(getOracleRouteStepKey(step))?.rate).toBe(42)
  })

  it('does not publish an in-flight quote after its component scope is disposed', async () => {
    const request = deferred<BatchItemResult[]>()
    evcBatchCall.mockReturnValue(request.promise)
    const state = start()
    await vi.waitFor(() => expect(evcBatchCall).toHaveBeenCalledTimes(1))
    scopes[0].stop()
    request.resolve(result(25n * 10n ** 18n))
    await settle()
    expect(state.prices.value.size).toBe(0)
  })
})
