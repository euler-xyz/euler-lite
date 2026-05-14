import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, onScopeDispose, ref, type Ref, watch } from 'vue'
import {
  DEFAULT_SLIPPAGE,
  DEFAULT_STABLECOIN_SLIPPAGE,
  SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY,
  SLIPPAGE_EXPIRY_MS,
  SLIPPAGE_OVERRIDE_STORAGE_KEY,
  SLIPPAGE_STORAGE_KEY,
  SLIPPAGE_TIMESTAMP_STORAGE_KEY,
} from '~/entities/constants'
import {
  getDefaultSlippageForContext,
  isSlippageOverrideActive,
  isStablecoinSwapContext,
  isUsdStablecoin,
  type SlippageOverride,
  useSlippage,
} from '~/composables/useSlippage'

const NOW = 2_000_000_000

const stateRefs = new Map<string, Ref<unknown>>()
const storageRefs = new Map<string, Ref<unknown>>()
const browserStorage = new Map<string, string>()

const installNuxtStorageMocks = (storage: Record<string, unknown> = {}) => {
  stateRefs.clear()
  storageRefs.clear()
  browserStorage.clear()

  for (const [key, value] of Object.entries(storage)) {
    browserStorage.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }

  const localStorageMock = {
    getItem: vi.fn((key: string) => {
      return browserStorage.get(key) ?? null
    }),
    setItem: vi.fn((key: string, value: string) => {
      browserStorage.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      browserStorage.delete(key)
    }),
  }

  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('onScopeDispose', onScopeDispose)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('useIntervalFn', () => ({ pause: vi.fn(), resume: vi.fn(), isActive: ref(false) }))
  vi.stubGlobal('useState', <T>(key: string, init: () => T): Ref<T> => {
    if (!stateRefs.has(key)) {
      stateRefs.set(key, ref(init()) as Ref<T>)
    }
    return stateRefs.get(key) as Ref<T>
  })
  vi.stubGlobal('useLocalStorage', <T>(
    key: string,
    init: T,
    options: { serializer?: { read: (value: string) => T, write: (value: T) => string } } = {},
  ): Ref<T> => {
    if (!storageRefs.has(key)) {
      const stored = localStorageMock.getItem(key)
      const initial = stored === null
        ? init
        : options.serializer?.read(stored) ?? stored
      const storageRef = ref(initial) as Ref<T>
      watch(storageRef, (value) => {
        if (value === null || value === undefined) {
          localStorageMock.removeItem(key)
          return
        }
        localStorageMock.setItem(key, options.serializer?.write(value) ?? String(value))
      }, { deep: true })
      storageRefs.set(key, storageRef)
    }
    return storageRefs.get(key) as Ref<T>
  })
}

const storageValue = <T>(key: string): T => storageRefs.get(key)?.value as T
const browserStorageValue = (key: string): string | null => globalThis.localStorage.getItem(key)

const flushSlippageTicks = async () => {
  await nextTick()
  await nextTick()
  await nextTick()
}

const mountSlippage = async (options?: Parameters<typeof useSlippage>[0]) => {
  const scope = effectScope()
  const api = scope.run(() => useSlippage(options))
  if (!api) throw new Error('useSlippage failed to mount')
  await flushSlippageTicks()
  return { scope, ...api }
}

const makeOverride = (
  value: number,
  defaultSlippageAtSet: number,
  setAt = NOW - 1_000,
): SlippageOverride => ({ value, setAt, defaultSlippageAtSet })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  installNuxtStorageMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useSlippage helpers', () => {
  it('classifies USD-denominated symbols as stablecoin swap pairs', () => {
    expect(isUsdStablecoin('USDC')).toBe(true)
    expect(isUsdStablecoin('RLUSD')).toBe(true)
    expect(isStablecoinSwapContext({ fromSymbol: 'USDC', toSymbol: 'RLUSD' })).toBe(true)
  })

  it('uses 0.05% as the default for stablecoin swap pairs', () => {
    const cases = [
      [{ fromSymbol: 'USDC', toSymbol: 'RLUSD' }, DEFAULT_STABLECOIN_SLIPPAGE],
      [{ fromSymbol: 'RLUSD', toSymbol: 'USDC' }, DEFAULT_STABLECOIN_SLIPPAGE],
      [{ fromSymbol: 'WETH', toSymbol: 'RLUSD' }, DEFAULT_SLIPPAGE],
      [{ fromSymbol: 'USDC', toSymbol: 'WETH' }, DEFAULT_SLIPPAGE],
      [{ fromSymbol: 'WETH', toSymbol: 'cbBTC' }, DEFAULT_SLIPPAGE],
      [null, DEFAULT_SLIPPAGE],
    ] as const

    for (const [ctx, expected] of cases) {
      expect(getDefaultSlippageForContext(ctx)).toBe(expected)
    }
  })

  it('does not apply a generic high override to stablecoin pairs', () => {
    expect(isSlippageOverrideActive(
      makeOverride(3, DEFAULT_SLIPPAGE),
      NOW,
      DEFAULT_STABLECOIN_SLIPPAGE,
    )).toBe(false)
  })

  it('keeps a stable-pair high override on stablecoin pairs until it expires', () => {
    expect(isSlippageOverrideActive(
      makeOverride(3, DEFAULT_STABLECOIN_SLIPPAGE),
      NOW,
      DEFAULT_STABLECOIN_SLIPPAGE,
    )).toBe(true)
  })

  it('keeps overrides at or below the active pair default', () => {
    const expiredSetAt = NOW - SLIPPAGE_EXPIRY_MS - 1

    expect(isSlippageOverrideActive(
      makeOverride(DEFAULT_STABLECOIN_SLIPPAGE, DEFAULT_STABLECOIN_SLIPPAGE, expiredSetAt),
      NOW,
      DEFAULT_STABLECOIN_SLIPPAGE,
    )).toBe(true)
    expect(isSlippageOverrideActive(
      makeOverride(0.01, DEFAULT_STABLECOIN_SLIPPAGE, expiredSetAt),
      NOW,
      DEFAULT_SLIPPAGE,
    )).toBe(true)
  })

  it('does not trust future override timestamps', () => {
    expect(isSlippageOverrideActive(
      makeOverride(0.5, DEFAULT_STABLECOIN_SLIPPAGE, NOW + 1),
      NOW,
      DEFAULT_STABLECOIN_SLIPPAGE,
    )).toBe(false)
  })
})

describe('useSlippage persisted state', () => {
  it('hydrates a fresh stable pair with the 0.05% default and no override', async () => {
    installNuxtStorageMocks()

    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(defaultSlippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(isOverrideActive.value).toBe(false)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('keeps a fresh stable-pair override on stable pairs', async () => {
    installNuxtStorageMocks()

    const { scope, slippage, setSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    setSlippage(3)
    await flushSlippageTicks()

    expect(isOverrideActive.value).toBe(true)
    expect(slippage.value).toBe(3)
    expect(storageValue<SlippageOverride>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toEqual({
      value: 3,
      setAt: NOW,
      defaultSlippageAtSet: DEFAULT_STABLECOIN_SLIPPAGE,
    })
    expect(browserStorageValue(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBe(JSON.stringify({
      value: 3,
      setAt: NOW,
      defaultSlippageAtSet: DEFAULT_STABLECOIN_SLIPPAGE,
    }))

    scope.stop()
  })

  it('uses the active pair default and clears the override when a custom value equals the default', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(3, DEFAULT_STABLECOIN_SLIPPAGE),
    })

    const { scope, slippage, setSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(slippage.value).toBe(3)

    setSlippage(DEFAULT_STABLECOIN_SLIPPAGE)
    await flushSlippageTicks()

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('clears the in-memory override when persisted override storage is cleared', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(3, DEFAULT_STABLECOIN_SLIPPAGE),
    })

    const { scope, slippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(slippage.value).toBe(3)

    storageRefs.get(SLIPPAGE_OVERRIDE_STORAGE_KEY)!.value = null
    await flushSlippageTicks()

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(browserStorageValue(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('does not carry a generic high override into stable pairs', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(3, DEFAULT_SLIPPAGE),
    })

    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(defaultSlippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('does not carry a stable high override into non-stable pairs', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(3, DEFAULT_STABLECOIN_SLIPPAGE),
    })

    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'WETH',
      toSymbol: () => 'cbBTC',
    })

    expect(defaultSlippage.value).toBe(DEFAULT_SLIPPAGE)
    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('keeps a lower-than-default override across pair contexts', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(0.01, DEFAULT_STABLECOIN_SLIPPAGE, NOW - SLIPPAGE_EXPIRY_MS - 1),
    })

    const fromSymbol = ref('USDC')
    const toSymbol = ref('RLUSD')
    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => fromSymbol.value,
      toSymbol: () => toSymbol.value,
    })

    expect(defaultSlippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(isOverrideActive.value).toBe(true)
    expect(slippage.value).toBe(0.01)

    fromSymbol.value = 'WETH'
    toSymbol.value = 'cbBTC'
    await flushSlippageTicks()

    expect(defaultSlippage.value).toBe(DEFAULT_SLIPPAGE)
    expect(isOverrideActive.value).toBe(true)
    expect(slippage.value).toBe(0.01)

    scope.stop()
  })

  it('expires a stale high override for the same pair default', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(3, DEFAULT_STABLECOIN_SLIPPAGE, NOW - SLIPPAGE_EXPIRY_MS - 1),
    })

    const { scope, slippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('ignores future persisted timestamps so high overrides cannot stay active indefinitely', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: makeOverride(0.5, DEFAULT_STABLECOIN_SLIPPAGE, NOW + SLIPPAGE_EXPIRY_MS),
    })

    const { scope, slippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('ignores invalid override objects', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_OVERRIDE_STORAGE_KEY]: { value: Number.NaN, setAt: NOW - 1_000, defaultSlippageAtSet: DEFAULT_STABLECOIN_SLIPPAGE },
    })

    const { scope, slippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('migrates stringified legacy stable-pair override values', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_STORAGE_KEY]: '3',
      [SLIPPAGE_TIMESTAMP_STORAGE_KEY]: String(NOW - 1_000),
      [SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY]: String(DEFAULT_STABLECOIN_SLIPPAGE),
    })

    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(defaultSlippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(isOverrideActive.value).toBe(true)
    expect(slippage.value).toBe(3)
    expect(storageValue<SlippageOverride>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toEqual({
      value: 3,
      setAt: NOW - 1_000,
      defaultSlippageAtSet: DEFAULT_STABLECOIN_SLIPPAGE,
    })
    expect(browserStorageValue(SLIPPAGE_STORAGE_KEY)).toBeNull()
    expect(browserStorageValue(SLIPPAGE_TIMESTAMP_STORAGE_KEY)).toBeNull()
    expect(browserStorageValue(SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('migrates a legacy generic high override but does not apply it to stable pairs', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_STORAGE_KEY]: '3',
      [SLIPPAGE_TIMESTAMP_STORAGE_KEY]: String(NOW - 1_000),
      [SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY]: String(DEFAULT_SLIPPAGE),
    })

    const { scope, slippage, defaultSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(defaultSlippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('ignores legacy values without timestamps', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_STORAGE_KEY]: 0.5,
      [SLIPPAGE_TIMESTAMP_STORAGE_KEY]: 0,
    })

    const { scope, slippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'USDC',
      toSymbol: () => 'RLUSD',
    })

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
    expect(storageValue<SlippageOverride | null>(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()

    scope.stop()
  })

  it('clears legacy override keys when resetting to the active default', async () => {
    installNuxtStorageMocks({
      [SLIPPAGE_STORAGE_KEY]: '3',
      [SLIPPAGE_TIMESTAMP_STORAGE_KEY]: String(NOW - 1_000),
      [SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY]: String(DEFAULT_SLIPPAGE),
    })

    const { scope, slippage, setSlippage, isOverrideActive } = await mountSlippage({
      fromSymbol: () => 'WETH',
      toSymbol: () => 'cbBTC',
    })

    expect(slippage.value).toBe(3)

    setSlippage(DEFAULT_SLIPPAGE)
    await flushSlippageTicks()

    expect(isOverrideActive.value).toBe(false)
    expect(slippage.value).toBe(DEFAULT_SLIPPAGE)
    expect(browserStorageValue(SLIPPAGE_OVERRIDE_STORAGE_KEY)).toBeNull()
    expect(browserStorageValue(SLIPPAGE_STORAGE_KEY)).toBeNull()
    expect(browserStorageValue(SLIPPAGE_TIMESTAMP_STORAGE_KEY)).toBeNull()
    expect(browserStorageValue(SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY)).toBeNull()

    scope.stop()
  })
})
