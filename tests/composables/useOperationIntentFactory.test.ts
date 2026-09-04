import { computed, ref } from 'vue'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOperationIntentFactory } from '~/composables/useOperationIntentFactory'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const ASSET = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')

describe('useOperationIntentFactory', () => {
  const walletChainId = ref<number | undefined>()
  const browsedChainId = ref(1)
  const route = { name: 'lend-vault', path: '/lend/vault' }

  beforeEach(() => {
    walletChainId.value = undefined
    browsedChainId.value = 1
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useEffectiveAddress', () => ({ effectiveAddress: ref<Address | undefined>(ACCOUNT) }))
    vi.stubGlobal('useWagmi', () => ({ chainId: walletChainId }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: browsedChainId }))
    vi.stubGlobal('useRoute', () => route)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the browsed chain when spy mode has no connected wallet chain', () => {
    const intent = useOperationIntentFactory().create({
      kind: 'deposit',
      planner: 'deposit',
      args: { vaultAddress: VAULT, assetAddress: ASSET, amount: 1n },
      source: 'test:spy-deposit',
      intentId: 'intent:spy-deposit',
      createdAt: 1,
    })

    expect(intent.account).toBe(ACCOUNT)
    expect(intent.chainId).toBe(1)
    expect(intent.metadata.operation).toBe('lend-vault')
  })

  it('prefers the connected wallet chain when one is available', () => {
    walletChainId.value = 8453

    const intent = useOperationIntentFactory().create({
      kind: 'deposit',
      planner: 'deposit',
      args: { vaultAddress: VAULT, assetAddress: ASSET, amount: 1n },
      source: 'test:connected-deposit',
      intentId: 'intent:connected-deposit',
      createdAt: 1,
    })

    expect(intent.chainId).toBe(8453)
  })
})
