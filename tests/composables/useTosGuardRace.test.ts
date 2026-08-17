import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'

const ACCOUNT_A = '0x1000000000000000000000000000000000000000' as const
const ACCOUNT_B = '0x2000000000000000000000000000000000000000' as const
const SIGNER = '0x3000000000000000000000000000000000000000' as const

const pendingReads: Array<{
  args: readonly unknown[]
  resolve: (value: bigint) => void
}> = []

vi.mock('~/composables/useTosData', () => ({
  getTosData: vi.fn(async () => ({
    tosMessage: 'current terms',
    tosMessageHash: `0x${'11'.repeat(32)}`,
  })),
}))

const flush = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

describe('useTosGuard account-switch checks', () => {
  beforeEach(() => {
    pendingReads.length = 0
  })

  afterEach(async () => {
    const { operationBlockerEntries, unregisterOperationBlocker } = await import('~/utils/operationGuardRegistry')
    for (const [key] of operationBlockerEntries.value) {
      if (key.startsWith('tos:')) unregisterOperationBlocker(key)
    }
    vi.unstubAllGlobals()
  })

  it('ignores a stale signed response from the previous wallet', async () => {
    const address = ref<string | undefined>(ACCOUNT_A)
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()
    const client = {
      readContract: vi.fn((request: { args: readonly unknown[] }) =>
        new Promise<bigint>((resolve) => {
          pendingReads.push({ args: request.args, resolve })
        })),
    }

    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('useWagmi', () => ({ address }))
    vi.stubGlobal('useEulerAddresses', () => ({
      eulerPeripheryAddresses: ref({ termsOfUseSigner: SIGNER }),
      isReady: ref(true),
      loadEulerConfig: vi.fn(),
      chainId,
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(client) }))
    vi.stubGlobal('useDeployConfig', () => ({
      enableTosSignature: true,
      tosUrl: 'https://example.invalid/terms',
    }))
    vi.stubGlobal('onMounted', (callback: () => void) => callback())
    vi.stubGlobal('onUnmounted', () => undefined)

    const { useTosGuard } = await import('~/composables/guards/useTosGuard')
    const { isOperationBlocked, operationBlockerEntries, operationBlockReason, unregisterOperationBlocker } = await import('~/utils/operationGuardRegistry')
    for (const [key] of operationBlockerEntries.value) {
      if (key.startsWith('tos:')) unregisterOperationBlocker(key)
    }

    useTosGuard()
    await flush()
    expect(pendingReads).toHaveLength(1)
    expect(pendingReads[0]?.args[0]).toBe(ACCOUNT_A)

    address.value = ACCOUNT_B
    await flush()
    expect(pendingReads).toHaveLength(2)
    expect(pendingReads[1]?.args[0]).toBe(ACCOUNT_B)
    expect(operationBlockReason.value).toBe('Checking Terms of Use acceptance')

    pendingReads[0]!.resolve(1n)
    await flush()

    expect(isOperationBlocked.value).toBe(true)
    expect(operationBlockReason.value).toBe('Checking Terms of Use acceptance')

    pendingReads[1]!.resolve(0n)
    await flush()
    expect(operationBlockReason.value).toBe('Terms of Use acceptance required')
  })

  it('lets the newest composable instance own the shared acceptance result', async () => {
    const address = ref<string | undefined>(ACCOUNT_A)
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()
    const client = {
      readContract: vi.fn((request: { args: readonly unknown[] }) =>
        new Promise<bigint>((resolve) => {
          pendingReads.push({ args: request.args, resolve })
        })),
    }

    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('useWagmi', () => ({ address }))
    vi.stubGlobal('useEulerAddresses', () => ({
      eulerPeripheryAddresses: ref({ termsOfUseSigner: SIGNER }),
      isReady: ref(true),
      loadEulerConfig: vi.fn(),
      chainId,
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(client) }))
    vi.stubGlobal('useDeployConfig', () => ({
      enableTosSignature: true,
      tosUrl: 'https://example.invalid/terms',
    }))
    vi.stubGlobal('onMounted', (callback: () => void) => callback())
    vi.stubGlobal('onUnmounted', () => undefined)

    const { useTosGuard } = await import('~/composables/guards/useTosGuard')
    const { operationBlockReason } = await import('~/utils/operationGuardRegistry')

    useTosGuard()
    await flush()
    expect(pendingReads).toHaveLength(1)

    useTosGuard()
    await flush()
    expect(pendingReads).toHaveLength(2)

    pendingReads[1]!.resolve(0n)
    await flush()
    expect(operationBlockReason.value).toBe('Terms of Use acceptance required')

    pendingReads[0]!.resolve(1n)
    await flush()
    expect(operationBlockReason.value).toBe('Terms of Use acceptance required')
  })

  it('invalidates shared acceptance when a different context mounts after an unobserved switch', async () => {
    const address = ref<string | undefined>(ACCOUNT_B)
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>([
      ['tosGuardHasSigned', ref(true)],
      ['tosGuardSessionAccepted', ref(true)],
      ['tosGuardLoadFailed', ref(false)],
      ['tosGuardCheckGeneration', ref(0)],
      ['tosGuardAcceptanceContext', ref(`1:${ACCOUNT_A.toLowerCase()}`)],
    ])
    const client = {
      readContract: vi.fn(async () => 0n),
    }

    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('useWagmi', () => ({ address }))
    vi.stubGlobal('useEulerAddresses', () => ({
      eulerPeripheryAddresses: ref({ termsOfUseSigner: SIGNER }),
      isReady: ref(true),
      loadEulerConfig: vi.fn(),
      chainId,
    }))
    vi.stubGlobal('useRpcClient', () => ({ client: ref(client) }))
    vi.stubGlobal('useDeployConfig', () => ({
      enableTosSignature: true,
      tosUrl: 'https://example.invalid/terms',
    }))
    vi.stubGlobal('onMounted', (callback: () => void) => callback())
    vi.stubGlobal('onUnmounted', () => undefined)

    const { useTosGuard } = await import('~/composables/guards/useTosGuard')
    const { operationBlockReason } = await import('~/utils/operationGuardRegistry')

    useTosGuard()
    expect(operationBlockReason.value).toBe('Checking Terms of Use acceptance')
    await flush()

    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      args: [ACCOUNT_B, `0x${'11'.repeat(32)}`],
    }))
    expect(operationBlockReason.value).toBe('Terms of Use acceptance required')
  })
})
