import { getAddress, zeroAddress } from 'viem'
import { SwapVerificationType } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { clearUnverifiedVaultAcknowledgements, recordUnverifiedVaultAcknowledgement } from '~/features/reviewed-execution/policy/acknowledgements'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { makeReviewedExecution, TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

const geo = vi.hoisted(() => ({
  labelsReady: { value: true },
  country: { value: 'US' as string | null | undefined },
  blocked: vi.fn(),
  restricted: vi.fn(),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  useGeoBlock: () => ({ country: geo.country }),
  isVaultBlockedByCountry: geo.blocked,
  isVaultRestrictedByCountry: geo.restricted,
}))

vi.mock('~/composables/useEulerLabels', () => ({
  getEulerLabelsVersion: () => 1,
  useEulerLabels: () => ({ isReady: geo.labelsReady }),
}))

const TARGET_VAULT = getAddress('0x5000000000000000000000000000000000000000')
const TARGET_TOKEN = getAddress('0x6000000000000000000000000000000000000000')
const sourceVault = { address: TEST_VAULT, chainId: 1, type: 'evault', asset: { address: TEST_TOKEN } }
const targetVault = { address: TARGET_VAULT, chainId: 1, type: 'evault', asset: { address: TARGET_TOKEN } }
const entries = new Map([
  [TEST_VAULT.toLowerCase(), { type: 'evk' as const, vault: sourceVault }],
  [TARGET_VAULT.toLowerCase(), { type: 'evk' as const, vault: targetVault }],
])
const verifyVault = vi.fn()
const fetchVault = vi.fn(async (_address: string) => undefined)

const swapIntent = (type = SwapVerificationType.SkimMin) => {
  const quote = makeSwapQuote()
  return createOperationIntent({
    kind: type === SwapVerificationType.DebtMax ? 'refinance' : 'collateral',
    planner: type === SwapVerificationType.DebtMax ? 'swap-debt' : 'swap-collateral',
    args: {
      swapQuote: {
        ...quote,
        tokenOut: { ...quote.tokenOut, address: TARGET_TOKEN },
        verify: { ...quote.verify, type, vault: TARGET_VAULT },
      },
      swapperMode: 0,
    },
    chainId: 1,
    account: TEST_ACCOUNT,
    subAccounts: [TEST_ACCOUNT],
    source: 'test',
    operation: 'lend-swap',
    createdAt: 1,
    intentId: 'two-vault-swap',
  })
}

describe('final two-vault swap policy', () => {
  beforeEach(() => {
    clearUnverifiedVaultAcknowledgements()
    geo.labelsReady.value = true
    geo.country.value = 'US'
    geo.blocked.mockReset().mockReturnValue(false)
    geo.restricted.mockReset().mockReturnValue(false)
    verifyVault.mockReset().mockImplementation((vault: { address: string }) => getAddress(vault.address) === TEST_VAULT)
    fetchVault.mockClear()
    vi.stubGlobal('useVaultRegistry', () => ({
      get: (address: string) => entries.get(address.toLowerCase()),
      getOrFetch: fetchVault,
      getVault: (address: string) => entries.get(address.toLowerCase())?.vault,
      isVerifiedVault: () => true,
    }))
    vi.stubGlobal('useTokenList', () => ({
      getTokenByAddress: (address: string) => getAddress(address) === TEST_TOKEN
        ? { address: TEST_TOKEN, symbol: 'TEST', decimals: 18 }
        : undefined,
    }))
    vi.stubGlobal('useVaults', () => ({
      isVaultGovernorVerified: verifyVault,
      isEarnVaultOwnerVerified: vi.fn(),
      isSecuritizeGovernorVerified: vi.fn(),
    }))
  })

  afterEach(() => {
    clearUnverifiedVaultAcknowledgements()
    vi.unstubAllGlobals()
  })

  it('rejects final vault policy while verification labels are unavailable', async () => {
    geo.labelsReady.value = false
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent()]))
      .rejects.toThrow('Vault verification is unavailable')
  })

  it.each([
    ['omitted', true],
    ['empty', true],
    ['omitted', false],
    ['empty', false],
  ] as const)('requires ready labels with %s intents and metadata present=%s', async (intentMode, metadataPresent) => {
    if (!metadataPresent) {
      vi.stubGlobal('useVaultRegistry', () => ({
        getVault: () => undefined,
        isVerifiedVault: () => false,
      }))
    }
    const requestSet = makeReviewedExecution().requestSet
    const resolve = () => intentMode === 'omitted'
      ? resolveAppPolicy(requestSet, 100)
      : resolveAppPolicy(requestSet, 100, [])

    geo.labelsReady.value = false
    await expect(resolve()).rejects.toThrow('Vault verification is unavailable')

    geo.labelsReady.value = true
    await expect(resolve()).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ concern: 'vault-metadata', result: expect.objectContaining({ state: 'allowed' }) }),
      ]),
    })
  })

  it.each([SwapVerificationType.SkimMin, SwapVerificationType.DebtMax])('applies the regional restriction to the %s quote target vault', async (type) => {
    geo.restricted.mockImplementation((address: string) => getAddress(address) === TARGET_VAULT)

    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent(type)]))
      .rejects.toThrow('restricted in your region')
    expect(geo.restricted).toHaveBeenCalledWith(TARGET_VAULT, { asset: targetVault.asset })
  })

  it.each([SwapVerificationType.SkimMin, SwapVerificationType.DebtMax])('requires acknowledgement for an unverified %s quote target vault', async (type) => {
    const requestSet = makeReviewedExecution().requestSet
    const intent = swapIntent(type)

    await expect(resolveAppPolicy(requestSet, 100, [intent]))
      .rejects.toThrow('acknowledgement does not cover the execution')

    recordUnverifiedVaultAcknowledgement({
      chainId: 1,
      account: TEST_ACCOUNT,
      operation: 'lend-swap',
      vaults: [TARGET_VAULT],
    })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
  })

  it('keeps source vault policy checks without applying them to a transferMin recipient', async () => {
    const quote = makeSwapQuote()
    const intent = createOperationIntent({
      kind: 'withdraw',
      planner: 'withdraw-and-swap',
      args: {
        vaultAddress: TEST_VAULT, assets: 10n, owner: TEST_ACCOUNT,
        swapQuote: {
          ...quote,
          accountOut: zeroAddress,
          receiver: TEST_ACCOUNT,
          transferOutputToReceiver: true,
          verify: { ...quote.verify, type: SwapVerificationType.TransferMin, vault: TEST_ACCOUNT, account: zeroAddress },
        },
      },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'position/withdraw',
    })
    const requestSet = makeReviewedExecution().requestSet

    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
    expect(fetchVault).toHaveBeenCalledExactlyOnceWith(TEST_VAULT)

    geo.restricted.mockImplementation((address: string) => getAddress(address) === TEST_VAULT)
    await expect(resolveAppPolicy(requestSet, 100, [intent])).rejects.toThrow('restricted in your region')

    geo.restricted.mockReturnValue(false)
    verifyVault.mockReturnValue(false)
    await expect(resolveAppPolicy(requestSet, 100, [intent])).rejects.toThrow('acknowledgement does not cover the execution')
    recordUnverifiedVaultAcknowledgement({
      chainId: 1, account: TEST_ACCOUNT, operation: intent.metadata.operation, vaults: [TEST_VAULT],
    })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
  })

  it('rejects acknowledgement from another operation or vault set', async () => {
    verifyVault.mockReturnValue(false)
    const requestSet = makeReviewedExecution().requestSet
    const intent = swapIntent()
    const baseAcknowledgement = {
      chainId: 1,
      account: TEST_ACCOUNT,
      operation: 'lend-swap',
      vaults: [TEST_VAULT, TARGET_VAULT],
    }

    recordUnverifiedVaultAcknowledgement({ ...baseAcknowledgement, operation: 'position-number-supply' })
    await expect(resolveAppPolicy(requestSet, 100, [intent]))
      .rejects.toThrow('acknowledgement does not cover the execution')

    clearUnverifiedVaultAcknowledgements()
    recordUnverifiedVaultAcknowledgement({ ...baseAcknowledgement, vaults: [TARGET_VAULT] })
    recordUnverifiedVaultAcknowledgement({ ...baseAcknowledgement, vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [intent]))
      .rejects.toThrow('acknowledgement does not cover the execution')
  })
})
