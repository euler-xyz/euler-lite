type RuntimeConfig = {
  public?: Record<string, unknown>
}

type GlobalWithRuntimeConfig = typeof globalThis & {
  useRuntimeConfig?: () => RuntimeConfig
}

export const useRuntimeConfig = (): RuntimeConfig => {
  const globalUseRuntimeConfig = (globalThis as GlobalWithRuntimeConfig).useRuntimeConfig
  return globalUseRuntimeConfig?.() ?? { public: {} }
}
