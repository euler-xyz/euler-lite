import {
  DEFAULT_SLIPPAGE,
  DEFAULT_STABLECOIN_SLIPPAGE,
  MAX_SLIPPAGE,
  MIN_SLIPPAGE,
  SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY,
  SLIPPAGE_EXPIRY_MS,
  SLIPPAGE_OVERRIDE_STORAGE_KEY,
  SLIPPAGE_STORAGE_KEY,
  SLIPPAGE_TIMESTAMP_STORAGE_KEY,
} from '~/entities/constants'

interface UseSlippageOptions {
  fromSymbol?: () => string | undefined
  toSymbol?: () => string | undefined
  enabled?: () => boolean
}

interface SwapContext {
  fromSymbol?: string
  toSymbol?: string
}

export interface SlippageOverride {
  value: number
  setAt: number
  defaultSlippageAtSet: number
}

export const isUsdStablecoin = (symbol: string | undefined): boolean => {
  if (!symbol) return false
  return symbol.toUpperCase().includes('USD')
}

export const isStablecoinSwapContext = (ctx: SwapContext | null | undefined): boolean => {
  if (!ctx) return false
  return isUsdStablecoin(ctx.fromSymbol) && isUsdStablecoin(ctx.toSymbol)
}

export const getDefaultSlippageForContext = (ctx: SwapContext | null | undefined): number =>
  isStablecoinSwapContext(ctx) ? DEFAULT_STABLECOIN_SLIPPAGE : DEFAULT_SLIPPAGE

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const normalizeSlippage = (value: unknown) => {
  const parsed = toFiniteNumber(value)
  if (parsed === null) return DEFAULT_SLIPPAGE
  return Math.min(MAX_SLIPPAGE, Math.max(MIN_SLIPPAGE, parsed))
}

const readLocalStorageValue = (key: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  }
  catch {
    return null
  }
}

const removeLocalStorageValue = (key: string) => {
  try {
    globalThis.localStorage?.removeItem(key)
  }
  catch {
    // Ignore unavailable browser storage.
  }
}

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

const parseSlippageOverride = (value: unknown): SlippageOverride | null => {
  const parsed = parseMaybeJson(value)
  if (!parsed || typeof parsed !== 'object') return null

  const valueNumber = toFiniteNumber((parsed as Partial<SlippageOverride>).value)
  const setAt = toFiniteNumber((parsed as Partial<SlippageOverride>).setAt)
  const defaultSlippageAtSet = toFiniteNumber((parsed as Partial<SlippageOverride>).defaultSlippageAtSet)

  if (valueNumber === null || setAt === null || defaultSlippageAtSet === null) {
    return null
  }

  return {
    value: normalizeSlippage(valueNumber),
    setAt,
    defaultSlippageAtSet,
  }
}

const parseLegacySlippageOverride = (
  value: unknown,
  setAtValue: unknown,
  defaultSlippageAtSetValue: unknown,
): SlippageOverride | null => {
  const valueNumber = toFiniteNumber(value)
  const setAt = toFiniteNumber(setAtValue)

  if (valueNumber === null || setAt === null || setAt <= 0) {
    return null
  }

  return {
    value: normalizeSlippage(valueNumber),
    setAt,
    defaultSlippageAtSet: toFiniteNumber(defaultSlippageAtSetValue) ?? DEFAULT_SLIPPAGE,
  }
}

const clearLegacySlippageStorage = () => {
  removeLocalStorageValue(SLIPPAGE_STORAGE_KEY)
  removeLocalStorageValue(SLIPPAGE_TIMESTAMP_STORAGE_KEY)
  removeLocalStorageValue(SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY)
}

const readBrowserSlippageOverride = (): {
  override: SlippageOverride | null
  migratedLegacy: boolean
} => {
  const override = parseSlippageOverride(readLocalStorageValue(SLIPPAGE_OVERRIDE_STORAGE_KEY))
  if (override) {
    return { override, migratedLegacy: false }
  }

  const legacyOverride = parseLegacySlippageOverride(
    readLocalStorageValue(SLIPPAGE_STORAGE_KEY),
    readLocalStorageValue(SLIPPAGE_TIMESTAMP_STORAGE_KEY),
    readLocalStorageValue(SLIPPAGE_CONTEXT_DEFAULT_STORAGE_KEY),
  )

  return { override: legacyOverride, migratedLegacy: Boolean(legacyOverride) }
}

const slippageOverrideSerializer = {
  read: (value: string): SlippageOverride | null => parseSlippageOverride(value),
  write: (value: SlippageOverride | null): string => JSON.stringify(value),
}

const slippageOverridesEqual = (
  a: SlippageOverride | null,
  b: SlippageOverride | null,
): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.value === b.value
    && a.setAt === b.setAt
    && a.defaultSlippageAtSet === b.defaultSlippageAtSet
}

export const isSlippageOverrideActive = (
  override: SlippageOverride | null,
  now: number,
  defaultSlippage: number,
): boolean => {
  if (!override) return false
  if (override.setAt <= 0) return false
  if (override.setAt > now) return false
  // Only expire or context-reset overrides above the active pair default.
  if (override.value <= defaultSlippage) return true
  if (override.defaultSlippageAtSet !== defaultSlippage) return false
  return (now - override.setAt) < SLIPPAGE_EXPIRY_MS
}

export const useSlippage = (options?: UseSlippageOptions) => {
  const browserStorage = readBrowserSlippageOverride()
  const persistedOverride = useLocalStorage<SlippageOverride | null>(
    SLIPPAGE_OVERRIDE_STORAGE_KEY,
    browserStorage.override,
    {
      serializer: slippageOverrideSerializer,
      writeDefaults: false,
    },
  )

  const override = useState<SlippageOverride | null>(`${SLIPPAGE_OVERRIDE_STORAGE_KEY}-state`, () =>
    browserStorage.override
    ?? parseSlippageOverride(persistedOverride.value),
  )

  const swapContext = useState<SwapContext | null>('slippage-swap-context', () => null)
  const canSyncPersisted = ref(false)
  let shouldPersistMigratedLegacy = browserStorage.migratedLegacy

  // Reactive clock for expiry detection (ticks every 60s)
  const now = ref(Date.now())
  useIntervalFn(() => {
    now.value = Date.now()
  }, 60_000)

  nextTick(() => {
    nextTick(() => {
      canSyncPersisted.value = true
    })
  })

  // When caller provides swap context, write it to shared state.
  // Deferred to nextTick so getters can reference variables declared
  // after useSlippage() in the calling scope.
  if (options?.fromSymbol || options?.toSymbol) {
    let stopWatch: (() => void) | undefined

    nextTick(() => {
      stopWatch = watchEffect(() => {
        if (options.enabled?.() === false) return
        swapContext.value = {
          fromSymbol: options.fromSymbol?.(),
          toSymbol: options.toSymbol?.(),
        }
      })
    })

    onScopeDispose(() => {
      stopWatch?.()
      swapContext.value = null
    })
  }

  const defaultSlippage = computed(() =>
    getDefaultSlippageForContext(swapContext.value),
  )

  const hasCompleteSwapContext = computed(() =>
    Boolean(swapContext.value?.fromSymbol && swapContext.value.toSymbol),
  )

  const isOverrideActive = computed(() =>
    isSlippageOverrideActive(override.value, now.value, defaultSlippage.value),
  )

  const effectiveSlippage = computed(() =>
    isOverrideActive.value ? override.value?.value ?? defaultSlippage.value : defaultSlippage.value,
  )

  watchEffect(() => {
    if (!canSyncPersisted.value) return

    if (!override.value) {
      if (persistedOverride.value !== null) {
        persistedOverride.value = null
      }
      clearLegacySlippageStorage()
      return
    }

    if (
      override.value.defaultSlippageAtSet !== DEFAULT_SLIPPAGE
      && !hasCompleteSwapContext.value
    ) return

    if (!isOverrideActive.value) {
      override.value = null
      persistedOverride.value = null
      clearLegacySlippageStorage()
      return
    }

    if (shouldPersistMigratedLegacy || !slippageOverridesEqual(persistedOverride.value, override.value)) {
      persistedOverride.value = { ...override.value }
      shouldPersistMigratedLegacy = false
    }
    if (browserStorage.migratedLegacy) {
      clearLegacySlippageStorage()
    }
  })

  const setSlippage = (value: number) => {
    const normalized = normalizeSlippage(value)

    if (normalized === defaultSlippage.value) {
      override.value = null
      persistedOverride.value = null
      clearLegacySlippageStorage()
      return
    }

    const setAt = Date.now()
    now.value = setAt

    const nextOverride = {
      value: normalized,
      setAt,
      defaultSlippageAtSet: defaultSlippage.value,
    }

    override.value = nextOverride
    persistedOverride.value = nextOverride
    clearLegacySlippageStorage()
  }

  return {
    slippage: effectiveSlippage as Ref<number>,
    setSlippage,
    minSlippage: MIN_SLIPPAGE,
    maxSlippage: MAX_SLIPPAGE,
    defaultSlippage,
    isOverrideActive,
  }
}
