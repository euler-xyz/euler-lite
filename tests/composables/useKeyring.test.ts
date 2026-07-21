import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readHookTargetValue } from '~/composables/useKeyring'

// Shared spies, hoisted so the vi.mock factories below can reference them.
const { readContract, logWarn } = vi.hoisted(() => ({
  readContract: vi.fn(),
  logWarn: vi.fn(),
}))

// Mock the modules useKeyring imports at load time. Only public-client and
// errorHandling drive the behaviour under test; the rest are stubbed so the
// module graph stays light and free of browser-only globals.
vi.mock('~/utils/public-client', () => ({
  getPublicClient: () => ({ readContract }),
}))
vi.mock('~/utils/errorHandling', () => ({ logWarn }))
vi.mock('@wagmi/vue', () => ({ useChainId: () => ({ value: 1 }) }))
vi.mock('@keyringnetwork/keyring-connect-sdk', () => ({ KeyringConnect: {} }))
vi.mock('~/utils/eulerLabelsUtils', () => ({ isVaultKeyring: () => true }))

const RPC = '/api/internal/rpc/1'
const HOOK = '0x00000000000000000000000000000000000000bB'
const KEYRING = '0x00000000000000000000000000000000000000cC'

beforeEach(() => {
  readContract.mockReset()
  logWarn.mockReset()
})

describe('readHookTargetValue — native/integrator getter fallback', () => {
  it('uses the native getter and makes no fallback call when policyId() resolves', async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') return 7
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<number>(RPC, HOOK, ['policyId', 'getPolicyId'])

    expect(value).toBe(7)
    expect(readContract).toHaveBeenCalledTimes(1)
    expect(readContract.mock.calls[0][0]).toMatchObject({ functionName: 'policyId' })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('falls back to getPolicyId() (uint256/bigint) when policyId() reverts', async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') throw new Error('execution reverted')
      if (functionName === 'getPolicyId') return 14623209n
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<number | bigint>(RPC, HOOK, ['policyId', 'getPolicyId'])

    expect(value).toBe(14623209n)
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('falls back to getKeyring() when keyring() reverts', async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'keyring') throw new Error('execution reverted')
      if (functionName === 'getKeyring') return KEYRING
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<string>(RPC, HOOK, ['keyring', 'getKeyring'])

    expect(value).toBe(KEYRING)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('returns undefined and logs once at error severity when every candidate reverts', async () => {
    readContract.mockRejectedValue(new Error('execution reverted'))

    const value = await readHookTargetValue<number>(RPC, HOOK, ['policyId', 'getPolicyId'])

    expect(value).toBeUndefined()
    expect(logWarn).toHaveBeenCalledTimes(1)
    // logWarn(context, lastError, { severity })
    expect(logWarn.mock.calls[0][2]).toMatchObject({ severity: 'error' })
  })
})
