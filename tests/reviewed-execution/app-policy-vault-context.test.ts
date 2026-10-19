import { getAddress, zeroAddress, zeroHash } from 'viem'
import { SwapVerificationType } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { clearDeprecatedDepositAcknowledgements, clearUnverifiedVaultAcknowledgements, recordDeprecatedDepositAcknowledgement, recordUnverifiedVaultAcknowledgement } from '~/features/reviewed-execution/policy/acknowledgements'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { collectPlannerVaultAddresses } from '~/features/reviewed-execution/planning/requirements'
import { makeReviewedExecution, TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'
import type { HostedGeoContext } from '~/utils/geo-policies'

const geo = vi.hoisted(() => ({
  labelsReady: { value: true },
  labelsSource: { value: 'static' },
  visibility: { value: {} as Record<string, { status: string }> },
  deprecated: new Set<string>(),
  country: { value: 'US' as string | null | undefined },
  context: undefined as HostedGeoContext | undefined,
  blocked: vi.fn(),
  restricted: vi.fn(),
}))

vi.mock('~/composables/useGeoBlock', () => ({
  useGeoBlock: () => ({ country: geo.country }),
  isVaultBlockedByCountry: geo.blocked,
  isVaultRestrictedByCountry: geo.restricted,
}))

vi.mock('~/composables/useEulerLabels', () => ({
  getEulerGeoContext: () => geo.context,
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
    clearDeprecatedDepositAcknowledgements()
    geo.labelsReady.value = true
    geo.labelsSource.value = 'static'
    geo.visibility.value = {}
    geo.deprecated.clear()
    geo.country.value = 'US'
    geo.context = undefined
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

  it('accepts the exact form guard sets for position withdrawal and repayment from a deposit during a labels outage', async () => {
    geo.labelsReady.value = false
    const requestSet = makeReviewedExecution().requestSet
    const withdrawal = createOperationIntent({
      kind: 'withdraw', planner: 'withdraw',
      args: { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n },
      chainId: 1, account: TEST_ACCOUNT, subAccounts: [TEST_ACCOUNT],
      source: 'position/withdraw:review', operation: 'position-number-withdraw', createdAt: 1,
    })
    const withdrawGuardVaults = collectPlannerVaultAddresses({ vaultAddress: TEST_VAULT })
    expect(withdrawGuardVaults).toEqual([TEST_VAULT])
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'position-number-withdraw', vaults: withdrawGuardVaults })
    await expect(resolveAppPolicy(requestSet, 100, [withdrawal])).resolves.toBeDefined()

    const repayment = createOperationIntent({
      kind: 'repay', planner: 'repay-from-deposit',
      args: { liabilityVault: TEST_VAULT, liabilityAsset: TEST_TOKEN, liabilityAmount: 1n, receiver: TEST_ACCOUNT, fromVault: TARGET_VAULT, fromAccount: TEST_ACCOUNT },
      chainId: 1, account: TEST_ACCOUNT, subAccounts: [TEST_ACCOUNT],
      source: 'position/repay-savings', operation: 'position-number-repay', createdAt: 1,
    })
    const repayGuardVaults = collectPlannerVaultAddresses({ liabilityVault: TEST_VAULT, fromVault: TARGET_VAULT })
    expect(repayGuardVaults).toEqual([TEST_VAULT, TARGET_VAULT])
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'position-number-repay', vaults: repayGuardVaults })
    await expect(resolveAppPolicy(requestSet, 100, [repayment])).resolves.toBeDefined()
  })

  it('keeps a withdrawal with a wallet swap available during a labels outage when geo is known', async () => {
    geo.labelsReady.value = false
    const intent = createOperationIntent({
      kind: 'withdraw', planner: 'withdraw-and-swap',
      args: { swapQuote: makeSwapQuote(), vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n },
      chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-withdraw', createdAt: 1,
    })
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-withdraw', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [intent])).resolves.toBeDefined()
    geo.country.value = null
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [intent]))
      .rejects.toThrow('Regional availability could not be determined')
  })

  it('blocks a new deposit when hosted geo expires while keeping a simple exit available', async () => {
    geo.context = { chainId: 1, policies: undefined, productByVault: {} }
    const deposit = createOperationIntent({ kind: 'deposit', planner: 'deposit', args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-deposit', createdAt: 1 })
    const withdrawal = createOperationIntent({ kind: 'withdraw', planner: 'withdraw', args: { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-withdraw', createdAt: 1 })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).rejects.toThrow('Compliance data unavailable')
    await expect(resolveAppPolicy(requestSet, 100, [withdrawal])).resolves.toBeDefined()
  })

  it.each([
    ['an unknown region', null, undefined, 'Regional availability could not be determined'],
    ['unavailable hosted geo policies', 'US', { chainId: 1, policies: undefined, productByVault: {} }, 'Compliance data unavailable'],
  ] as const)('blocks outbound migration with %s', async (_case, country, context, expectedError) => {
    geo.country.value = country
    geo.context = context
    const intent = createOperationIntent({
      kind: 'migration', planner: 'cross-protocol-migration',
      args: {
        direction: 'euler-to-external', connectorId: 'aave', owner: TEST_ACCOUNT,
        positionRef: { collateralAsset: TEST_TOKEN, debtAsset: TEST_TOKEN, pool: TEST_VAULT },
        source: { eulerAccount: TEST_ACCOUNT, borrowVault: TARGET_VAULT, collateralVault: TEST_VAULT },
        deadline: 1_000n,
        authorizationEvidenceDigest: zeroHash,
      },
      chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'migrate-out', createdAt: 1,
      constraints: [{ kind: 'deadline', timestamp: 1_000 }],
    })
    await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [intent]))
      .rejects.toThrow(expectedError)
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

  it('requires acknowledgement for a pending-review deposit and permits an exit', async () => {
    geo.labelsSource.value = 'v3'
    geo.visibility.value = { [TEST_VAULT.toLowerCase()]: { status: 'pending_review' } }
    verifyVault.mockReturnValue(false)
    const deposit = createOperationIntent({ kind: 'deposit', planner: 'deposit', args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-deposit', createdAt: 1 })
    const withdrawal = createOperationIntent({ kind: 'withdraw', planner: 'withdraw', args: { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n }, chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'lend-withdraw', createdAt: 1 })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).rejects.toThrow('acknowledgement does not cover the execution')
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-deposit', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [deposit])).resolves.toBeDefined()
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-withdraw', vaults: [TEST_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [withdrawal])).resolves.toBeDefined()
  })

  it('requires acknowledgement for a pending-review swap destination', async () => {
    geo.labelsSource.value = 'v3'
    geo.visibility.value = { [TARGET_VAULT.toLowerCase()]: { status: 'pending_review' } }
    const requestSet = makeReviewedExecution().requestSet
    const intent = swapIntent()
    await expect(resolveAppPolicy(requestSet, 100, [intent])).rejects.toThrow('acknowledgement does not cover the execution')
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'lend-swap', vaults: [TARGET_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
  })

  it('requires acknowledgement when refinancing into a pending-review debt vault', async () => {
    geo.labelsSource.value = 'v3'
    geo.visibility.value = { [TARGET_VAULT.toLowerCase()]: { status: 'pending_review' } }
    const quote = makeSwapQuote()
    const intent = createOperationIntent({
      kind: 'refinance', planner: 'refinance-position',
      args: {
        debt: {
          planner: 'swap-debt',
          args: {
            swapQuote: {
              ...quote,
              vaultIn: TARGET_VAULT,
              receiver: TEST_VAULT,
              verify: { ...quote.verify, vault: TEST_VAULT },
            },
          },
        },
      },
      chainId: 1, account: TEST_ACCOUNT, source: 'test', operation: 'refinance', createdAt: 1,
    })
    const requestSet = makeReviewedExecution().requestSet
    await expect(resolveAppPolicy(requestSet, 100, [intent])).rejects.toThrow('acknowledgement does not cover the execution')
    recordUnverifiedVaultAcknowledgement({ chainId: 1, account: TEST_ACCOUNT, operation: 'refinance', vaults: [TARGET_VAULT] })
    await expect(resolveAppPolicy(requestSet, 100, [intent])).resolves.toBeDefined()
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
