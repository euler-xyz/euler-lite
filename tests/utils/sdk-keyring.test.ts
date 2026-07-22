import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { CredentialData } from '@keyringnetwork/keyring-connect-sdk'
import {
  clearSdkKeyringCredential,
  getSdkKeyringCredential,
  setSdkKeyringCredential,
} from '~/utils/sdk-keyring'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK_TARGET = '0x2222222222222222222222222222222222222222' as Address
const KEYRING = '0x3333333333333333333333333333333333333333' as Address
const OTHER_KEYRING = '0x4444444444444444444444444444444444444444' as Address
const RPC_URL = '/api/internal/rpc/1'

const { getPublicClient, logWarn, resolveKeyringContractAddress } = vi.hoisted(() => ({
  getPublicClient: vi.fn(),
  logWarn: vi.fn(),
  resolveKeyringContractAddress: vi.fn(),
}))

vi.mock('~/utils/public-client', () => ({ getPublicClient }))
vi.mock('~/utils/keyring-hook-target', () => ({ resolveKeyringContractAddress }))
vi.mock('~/utils/errorHandling', () => ({ logWarn }))

const credential = (validUntil = 2_000_000_000): CredentialData => ({
  trader: ACCOUNT,
  policyId: 7,
  chainId: 1,
  validUntil,
  cost: 1,
  key: '0x01',
  signature: '0x02',
  backdoor: '0x03',
})

const key = {
  chainId: 1,
  account: ACCOUNT,
  hookTarget: HOOK_TARGET,
  policyId: 7,
}

describe('SDK Keyring credential cache', () => {
  beforeEach(() => {
    getPublicClient.mockReset()
    logWarn.mockReset()
    resolveKeyringContractAddress.mockReset()
    getPublicClient.mockReturnValue({})
    resolveKeyringContractAddress.mockResolvedValue(KEYRING)
  })

  afterEach(() => {
    clearSdkKeyringCredential(key)
  })

  it('returns a current credential when the hook target still resolves to the cached Keyring contract', async () => {
    setSdkKeyringCredential({
      ...key,
      keyringContractAddress: KEYRING,
      rpcUrl: RPC_URL,
      credential: credential(),
    })

    await expect(getSdkKeyringCredential(key)).resolves.toMatchObject({
      trader: ACCOUNT,
      policyId: 7,
      chainId: 1,
    })
    expect(getPublicClient).toHaveBeenCalledWith(RPC_URL)
    expect(resolveKeyringContractAddress).toHaveBeenCalledWith({}, HOOK_TARGET)
  })

  it('rejects a cached credential when the hook target resolves to a different Keyring contract', async () => {
    setSdkKeyringCredential({
      ...key,
      keyringContractAddress: KEYRING,
      rpcUrl: RPC_URL,
      credential: credential(),
    })
    resolveKeyringContractAddress.mockResolvedValue(OTHER_KEYRING)

    await expect(getSdkKeyringCredential(key)).resolves.toBeNull()
  })

  it('fails closed on a transient resolution error and retains the credential for retry', async () => {
    setSdkKeyringCredential({
      ...key,
      keyringContractAddress: KEYRING,
      rpcUrl: RPC_URL,
      credential: credential(),
    })
    const resolutionError = new Error('temporary RPC failure')
    resolveKeyringContractAddress
      .mockRejectedValueOnce(resolutionError)
      .mockResolvedValueOnce(KEYRING)

    await expect(getSdkKeyringCredential(key)).resolves.toBeNull()
    expect(logWarn).toHaveBeenCalledWith('sdkKeyring/resolveKeyringContractAddress', resolutionError)

    await expect(getSdkKeyringCredential(key)).resolves.toMatchObject({
      trader: ACCOUNT,
      policyId: 7,
      chainId: 1,
    })
  })

  it('rejects an expired cached credential without reading the hook target', async () => {
    setSdkKeyringCredential({
      ...key,
      keyringContractAddress: KEYRING,
      rpcUrl: RPC_URL,
      credential: credential(1),
    })

    await expect(getSdkKeyringCredential(key)).resolves.toBeNull()
    expect(resolveKeyringContractAddress).not.toHaveBeenCalled()
  })
})
