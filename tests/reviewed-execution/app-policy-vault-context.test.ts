import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { clearDeprecatedDepositAcknowledgements, clearUnverifiedVaultAcknowledgements, recordDeprecatedDepositAcknowledgement, recordUnverifiedVaultAcknowledgement } from '~/features/reviewed-execution/policy/acknowledgements'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { makeReviewedExecution, TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

const geo = vi.hoisted(() => ({
  labelsReady: { value: true },
  labelsSource: { value: 'static' },
  visibility: { value: {} as Record<string, { status: string }> },
  deprecated: new Set<string>(),
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
  useEulerLabels: () => ({ isReady: geo.labelsReady, source: geo.labelsSource, visibility: geo.visibility }),
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getVaultDeprecation: (address: string) => ({ deprecated: geo.deprecated.has(address.toLowerCase()), reason: 'Deprecated' }),
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

const swapIntent = () => {
  const quote = makeSwapQuote()
  return createOperationIntent({
    kind: 'collateral',
    planner: 'swap-collateral',
    args: {
      swapQuote: {
        ...quote,
        tokenOut: { ...quote.tokenOut, address: TARGET_TOKEN },
        verify: { ...quote.verify, vault: TARGET_VAULT },
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
    clearDeprecatedDepositAcknowledgements()
    geo.labelsReady.value = true
    geo.labelsSource.value = 'static'
    geo.visibility.value = {}
    geo.deprecated.clear()
    geo.country.value = 'US'
    geo.blocked.mockReset().mockReturnValue(false)
    geo.restricted.mockReset().mockReturnValue(false)
    verifyVault.mockReset().mockImplementation((vault: { address: string }) => getAddress(vault.address) === TEST_VAULT)
    vi.stubGlobal('useVaultRegistry', () => ({
      get: (address: string) => entries.get(address.toLowerCase()),
      getOrFetch: vi.fn(async () => undefined),
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
    clearDeprecatedDepositAcknowledgements()
    vi.unstubAllGlobals()
  })

  it('rejects final vault policy while verification labels are unavailable', async () => {
    geo.labelsReady.value = false
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent()]))
      .rejects.toThrow('Vault verification is unavailable')
  })

  it('allows an acknowledged simple withdrawal during a labels outage, but not a mixed swap batch', async () => {
    geo.labelsReady.value = false
    const intent = createOperationIntent({ kind: 'withdraw', planner: 'withdraw', args: { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n }, chainId: 1, account: TEST_ACCOUNT, subAccounts: [TEST_ACCOUNT], source: 'test', operation: 'lend-withdraw', createdAt: 1, intentId: 'exit' })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [intent])).rejects.toThrow('acknowledgement')
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-withdraw', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
    await expect(resolveAppPolicy(requestSet, 100, [intent, swapIntent()])).rejects.toThrow('Vault verification is unavailable')
  })

  it('keeps a withdrawal with a wallet swap available when labels and geo are unavailable', async () => {
    geo.labelsReady.value = false
    geo.country.value = null
    const intent = createOperationIntent({
      kind: 'withdraw', planner: 'withdraw-and-swap',
      args: { swapQuote: makeSwapQuote(), vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n },
      chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-withdraw', createdAt: 1,
    })
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-withdraw', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [intent])).resolves.toBeDefined()
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

  it('applies the regional restriction to the quote target vault', async () => {
    geo.restricted.mockImplementation((address: string) => getAddress(address) === TARGET_VAULT)

    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent()]))
      .rejects.toThrow('restricted in your region')
    expect(geo.restricted).toHaveBeenCalledWith(TARGET_VAULT, { asset: targetVault.asset })
  })

  it('requires acknowledgement for an unverified quote target vault', async () => {
    const requestSet = makeReviewedExecution().requestSet
    const intent = swapIntent()

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

  it('blocks pending-review deposits but permits an acknowledged withdrawal', async () => {
    geo.labelsSource.value = 'v3'
    geo.visibility.value = { [TEST_VAULT.toLowerCase()]: { status: 'pending_review' } }
    const deposit = createOperationIntent({ kind: 'deposit', planner: 'deposit', args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-deposit', createdAt: 1 })
    const withdrawal = createOperationIntent({ kind: 'withdraw', planner: 'withdraw', args: { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-withdraw', createdAt: 1 })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).rejects.toThrow('not been checked yet')
    await expect(resolveAppPolicy(requestSet, 100, [withdrawal])).resolves.toBeDefined()
  })

  it('blocks a pending-review swap destination even when the source vault is verified', async () => {
    geo.labelsSource.value = 'v3'
    geo.visibility.value = { [TARGET_VAULT.toLowerCase()]: { status: 'pending_review' } }
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [swapIntent()]))
      .rejects.toThrow('not been checked yet')
  })

  it('requires a distinct deprecated-deposit acknowledgement bound to the operation', async () => {
    geo.deprecated.add(TEST_VAULT.toLowerCase())
    const deposit = createOperationIntent({ kind: 'deposit', planner: 'deposit', args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-deposit', createdAt: 1 })
    const requestSet = makeReviewedExecution().requestSet
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-deposit', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).rejects.toThrow('Deprecated vault deposit acknowledgement')
    recordDeprecatedDepositAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-deposit', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).resolves.toBeDefined()
  })

  it('requires acknowledgement for the actual swap deposit receiver', async () => {
    verifyVault.mockReturnValue(true)
    geo.deprecated.add(TARGET_VAULT.toLowerCase())
    const quote = makeSwapQuote()
    const deposit = createOperationIntent({
      kind: 'deposit', planner: 'deposit-with-swap',
      args: { swapQuote: { ...quote, receiver: TARGET_VAULT, verify: { ...quote.verify, vault: TEST_VAULT } }, amount: 10n, tokenIn: TEST_TOKEN },
      chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-deposit', createdAt: 1,
    })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).rejects.toThrow('Deprecated vault deposit acknowledgement')
    recordDeprecatedDepositAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-deposit', vaults: [TARGET_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).resolves.toBeDefined()
  })
})
