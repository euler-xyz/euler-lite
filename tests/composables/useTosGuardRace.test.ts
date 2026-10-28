import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'

const ACCOUNT_A = '0x1000000000000000000000000000000000000000' as const
const ACCOUNT_B = '0x2000000000000000000000000000000000000000' as const
const SIGNER = '0x3000000000000000000000000000000000000000' as const

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

describe('useTosGuard context races', () => {
  afterEach(async () => {
    const { operationBlockerEntries, unregisterOperationBlocker } = await import('~/utils/operationGuardRegistry')
    for (const [key] of operationBlockerEntries.value) {
      if (key.startsWith('tos:')) unregisterOperationBlocker(key)
    }
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('ignores a signed response from the account that was switched away', async () => {
    const address = ref<string | undefined>(ACCOUNT_A)
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()
    const pendingReads: Array<{ args: readonly unknown[], resolve: (value: bigint) => void }> = []
    const client = {
      readContract: vi.fn((request: { args: readonly unknown[] }) =>
        new Promise<bigint>(resolve => pendingReads.push({ args: request.args, resolve }))),
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
    vi.stubGlobal('useDeployConfig', () => ({ enableTosSignature: true }))
    vi.stubGlobal('onMounted', (callback: () => void) => callback())
    vi.stubGlobal('onUnmounted', () => undefined)

    const { useTosGuard } = await import('~/composables/guards/useTosGuard')
    const { operationBlockReason } = await import('~/utils/operationGuardRegistry')
    useTosGuard()
    await flush()
    expect(pendingReads[0]?.args[0]).toBe(ACCOUNT_A)

    address.value = ACCOUNT_B
    await flush()
    expect(pendingReads[1]?.args[0]).toBe(ACCOUNT_B)
    expect(operationBlockReason.value).toBe('Checking Terms of Use acceptance')

    pendingReads[0]!.resolve(1n)
    await flush()
    expect(operationBlockReason.value).toBe('Checking Terms of Use acceptance')

    pendingReads[1]!.resolve(0n)
    await flush()
    expect(operationBlockReason.value).toBe('Terms of Use acceptance required')
  })
})
