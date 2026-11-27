import { getAddress, zeroAddress, zeroHash } from 'viem'
import { SwapVerificationType } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent, type CreateOperationIntentInput } from '~/features/reviewed-execution/domain/factory'
import { clearDeprecatedDepositAcknowledgements, clearUnverifiedVaultAcknowledgements, recordDeprecatedDepositAcknowledgement, recordUnverifiedVaultAcknowledgement } from '~/features/reviewed-execution/policy/acknowledgements'
import type { WithdrawalPolicyContext } from '~/features/reviewed-execution/policy/exit-only-withdrawals'
import { ReviewedExecutionCoordinator } from '~/features/reviewed-execution/coordinator/coordinator'
import { EoaExecutionAdapter } from '~/features/reviewed-execution/adapters/eoa'
import { resolveAppPolicy } from '~/features/reviewed-execution/policy/app-policy'
import { ADDRESS_EXIT_ONLY_MESSAGE, setAddressExitOnly } from '~/composables/addressExitOnlyState'
import { collectPlannerVaultAddresses, collectPlanningRequirements } from '~/features/reviewed-execution/planning/requirements'
import { artifactFor, materializedExecutorFor, makeReviewedExecution, TEST_ACCOUNT, TEST_EVC, TEST_TOKEN, TEST_VAULT } from './fixtures'
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

  describe('exit-only address', () => {
    const intentFor = (kind: CreateOperationIntentInput['kind'], planner: CreateOperationIntentInput['planner'], args: Record<string, unknown>, constraints?: CreateOperationIntentInput['constraints']) =>
      createOperationIntent({ kind, planner, args, constraints, chainId: 1, account: TEST_ACCOUNT, subAccounts: [TEST_ACCOUNT], source: 'test', operation: 'exit-only-test', createdAt: 1, intentId: `exit-only-${planner}` })
    let debt = 0n
    let collaterals = [TEST_VAULT]
    let controllers = [TARGET_VAULT]
    const getBlockNumber = vi.fn(async () => 101n)
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getCollaterals') return collaterals
      if (functionName === 'getControllers') return controllers
      if (functionName === 'debtOf') return debt
      throw new Error(`Unexpected read: ${functionName}`)
    })
    const withdrawalContext: WithdrawalPolicyContext = {
      provider: { getBlockNumber, readContract } as unknown as WithdrawalPolicyContext['provider'],
      evcAddress: TEST_EVC,
    }
    const withdrawArgs = { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, assets: 1n }
    const repayArgs = { liabilityVault: TEST_VAULT, liabilityAsset: TEST_TOKEN, liabilityAmount: 1n, receiver: TEST_ACCOUNT }
    const swap = { swapQuote: makeSwapQuote() }
    const collateralLeg = { collateralVault: TEST_VAULT, collateralAmount: 1n, collateralAsset: TEST_TOKEN }

    const allowedIntents = {
      'withdraw': () => intentFor('withdraw', 'withdraw', withdrawArgs),
      'redeem': () => intentFor('withdraw', 'redeem', { vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, shares: 1n }),
      'repay-from-wallet': () => intentFor('repay', 'repay-from-wallet', repayArgs),
      'repay-from-deposit': () => intentFor('repay', 'repay-from-deposit', { ...repayArgs, fromVault: TARGET_VAULT, fromAccount: TEST_ACCOUNT }),
      'repay-with-swap': () => intentFor('repay', 'repay-with-swap', swap),
      'swap-and-repay': () => intentFor('repay', 'swap-and-repay', { ...swap, amount: 1n, tokenIn: TEST_TOKEN, liabilityVault: TEST_VAULT }),
      'cleanup': () => intentFor('collateral', 'cleanup', { subAccount: TEST_ACCOUNT }, []),
      'reward-claim': () => intentFor('reward-claim', 'reward-claim', { claimIds: ['claim-1'], provider: 'merkl', rewardsDigest: zeroHash }, [{ kind: 'selected-rewards', claimIds: ['claim-1'] }]),
      'reul-unlock': () => intentFor('reul-unlock', 'reul-unlock', { lockTimestamps: [1], lockAmounts: [1n], remainderLossMaximum: 0n }, [{ kind: 'remainder-loss', token: TEST_TOKEN, maximumLoss: 0n }]),
    }

    const refinanceDebt = () => ({ debt: { planner: 'swap-debt', args: { swapQuote: { ...makeSwapQuote(), vaultIn: TARGET_VAULT, receiver: TEST_VAULT } } } })
    const migration = (direction: string) => ({
      direction, connectorId: 'aave', owner: TEST_ACCOUNT,
      positionRef: { collateralAsset: TEST_TOKEN, debtAsset: TEST_TOKEN, pool: TEST_VAULT },
      deadline: 1_000n,
      authorizationEvidenceDigest: zeroHash,
    })
    const refusedIntents = {
      'deposit': () => intentFor('deposit', 'deposit', { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n }),
      'deposit-with-swap': () => intentFor('deposit', 'deposit-with-swap', { ...swap, amount: 1n, tokenIn: TEST_TOKEN }),
      'borrow': () => intentFor('borrow', 'borrow', { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 1n, borrowAccount: TEST_ACCOUNT }),
      'swap-and-borrow': () => intentFor('borrow', 'swap-and-borrow', { ...swap, amount: 1n, tokenIn: TEST_TOKEN, borrowVault: TEST_VAULT, borrowAmount: 1n }),
      'multiply-with-swap': () => intentFor('borrow', 'multiply-with-swap', { ...swap, ...collateralLeg }),
      'multiply-same-asset': () => intentFor('borrow', 'multiply-same-asset', { ...collateralLeg, longVault: TEST_VAULT, liabilityVault: TARGET_VAULT, liabilityAmount: 1n, receiver: TEST_ACCOUNT }),
      'withdraw-and-swap': () => intentFor('withdraw', 'withdraw-and-swap', { ...swap, ...withdrawArgs }),
      'redeem-and-swap': () => intentFor('withdraw', 'redeem-and-swap', { ...swap, vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT, shares: 1n }),
      'swap-from-wallet': () => intentFor('swap', 'swap-from-wallet', { ...swap, amount: 1n, tokenIn: TEST_TOKEN }),
      'swap-collateral': () => swapIntent(),
      'swap-debt': () => swapIntent(SwapVerificationType.DebtMax),
      'refinance-position': () => intentFor('refinance', 'refinance-position', refinanceDebt()),
      'migrate-same-asset-collateral': () => intentFor('collateral', 'migrate-same-asset-collateral', { fromVault: TEST_VAULT, toVault: TARGET_VAULT, amount: 1n, positionAccount: TEST_ACCOUNT, toAsset: TARGET_TOKEN }),
      'migrate-same-asset-debt': () => intentFor('refinance', 'migrate-same-asset-debt', { oldLiabilityVault: TEST_VAULT, newLiabilityVault: TARGET_VAULT, newLiabilityAsset: TEST_TOKEN, liabilityAmount: 1n, liabilityAccount: TEST_ACCOUNT }),
      'transfer': () => intentFor('collateral', 'transfer', { vaultAddress: TEST_VAULT, from: TEST_ACCOUNT, to: TEST_ACCOUNT, amount: 1n }),
      'external-to-Euler migration': () => intentFor('migration', 'cross-protocol-migration', { ...migration('external-to-euler'), target: { eulerAccount: TEST_ACCOUNT, collateralVault: TEST_VAULT, borrowVault: TARGET_VAULT } }, [{ kind: 'deadline', timestamp: 1_000 }]),
      'Euler-to-external migration': () => intentFor('migration', 'cross-protocol-migration', { ...migration('euler-to-external'), source: { eulerAccount: TEST_ACCOUNT, collateralVault: TEST_VAULT, borrowVault: TARGET_VAULT } }, [{ kind: 'deadline', timestamp: 1_000 }]),
    }

    beforeEach(() => {
      debt = 0n
      collaterals = [TEST_VAULT]
      controllers = [TARGET_VAULT]
      getBlockNumber.mockClear()
      readContract.mockClear()
      setAddressExitOnly(true)
      geo.blocked.mockReturnValue(true)
      verifyVault.mockReturnValue(true)
    })
    afterEach(() => setAddressExitOnly(false))

    it.each(Object.keys(allowedIntents) as Array<keyof typeof allowedIntents>)('passes %s', async (planner) => {
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents[planner]()], withdrawalContext)).resolves.toBeDefined()
    })

    it.each(['withdraw', 'redeem'] as const)('refuses current collateral debt for %s without trusting the form snapshot', async (planner) => {
      debt = 1n
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents[planner]()], withdrawalContext))
        .rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
      expect(getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 })
      expect(readContract.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({ address: TEST_EVC, functionName: 'getCollaterals', args: [TEST_ACCOUNT], blockNumber: 101n }),
        expect.objectContaining({ address: TEST_EVC, functionName: 'getControllers', args: [TEST_ACCOUNT], blockNumber: 101n }),
        expect.objectContaining({ address: TARGET_VAULT, functionName: 'debtOf', args: [TEST_ACCOUNT], blockNumber: 101n }),
      ])
    })

    it('does not count a repayment queued ahead of a batch withdrawal as settled debt', async () => {
      debt = 1n
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100,
        [allowedIntents['repay-from-wallet'](), allowedIntents.withdraw(), allowedIntents.redeem()], withdrawalContext))
        .rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
      expect(getBlockNumber).toHaveBeenCalledOnce()
      expect(readContract).toHaveBeenCalledTimes(3)
    })

    it('allows non-collateral withdrawal while another vault backs debt', async () => {
      debt = 1n
      collaterals = [TARGET_VAULT]
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents.withdraw()], withdrawalContext)).resolves.toBeDefined()
      expect(readContract).toHaveBeenCalledOnce()
    })

    it('allows collateral withdrawal without an enabled controller', async () => {
      controllers = []
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents.redeem()], withdrawalContext)).resolves.toBeDefined()
      expect(readContract).toHaveBeenCalledTimes(2)
    })

    it('keeps debt repayment available without collateral RPC reads', async () => {
      debt = 1n
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents['repay-from-deposit']()], withdrawalContext)).resolves.toBeDefined()
      expect(getBlockNumber).not.toHaveBeenCalled()
    })

    it('fails closed without a current exposure reader', async () => {
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents.withdraw()])).rejects.toThrow('Current collateral debt is unavailable')
    })

    it.each(['getCollaterals', 'getControllers', 'debtOf'])('fails closed when %s cannot be read', async (failure) => {
      const read = vi.fn(async (request: { functionName: string }) => {
        if (request.functionName === failure) throw new Error('RPC unavailable')
        return readContract(request)
      })
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents.withdraw()], {
        ...withdrawalContext, provider: { getBlockNumber, readContract: read } as unknown as WithdrawalPolicyContext['provider'],
      })).rejects.toThrow('RPC unavailable')
    })

    it.each(['withdraw', 'redeem'] as const)('rechecks %s debt at the coordinator handoff after a successful review', async (planner) => {
      const execution = makeReviewedExecution('eoa', { intent: allowedIntents[planner]() })
      await resolveAppPolicy(execution.requestSet, 100, execution.intents, withdrawalContext)
      const sendTransaction = vi.fn(async () => zeroHash)
      const waitForReceipt = async () => ({ transactionHash: zeroHash, status: 'success' as const })
      const eoa = new EoaExecutionAdapter({ sendTransaction }, materializedExecutorFor(waitForReceipt), TEST_EVC)
      const coordinator = new ReviewedExecutionCoordinator({
        adapters: { eoa, safe: { transport: 'safe', dispatch: async () => { throw new Error('Unexpected Safe') } } },
        readWalletBinding: async () => execution.requestSet.wallet,
        revalidatePolicy: async (current) => { await resolveAppPolicy(current.requestSet, 100, current.intents, withdrawalContext) },
        collectSignature: async () => '0x01',
        refreshPyth: async () => [],
        finalize: artifactFor,
        now: () => 100,
      })
      debt = 1n
      await expect(coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest })).resolves.toMatchObject({ status: 'failed', message: ADDRESS_EXIT_ONLY_MESSAGE })
      expect(sendTransaction).not.toHaveBeenCalled()
      // An actual settled repayment makes the same exit eligible on its next check.
      debt = 0n
      await expect(coordinator.execute(execution, { reviewId: execution.reviewId, reviewDigest: execution.reviewDigest })).resolves.toMatchObject({ status: 'submitted' })
      expect(sendTransaction).toHaveBeenCalledOnce()
      expect(getBlockNumber.mock.calls.length).toBeGreaterThan(2)
    })

    it.each(Object.keys(refusedIntents) as Array<keyof typeof refusedIntents>)('refuses %s without regional wording', async (planner) => {
      const refusal = resolveAppPolicy(makeReviewedExecution().requestSet, 100, [refusedIntents[planner]()])
      await expect(refusal).rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
      await expect(refusal).rejects.not.toThrow(/region/i)
    })

    it('refuses a mixed batch when one intent is not an exit', async () => {
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [allowedIntents.withdraw(), refusedIntents.deposit()]))
        .rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
    })

    it.each([
      ['a loading country', undefined, undefined],
      ['an unknown country', null, undefined],
      ['expired geo policies', 'US', { chainId: 1, policies: undefined, productByVault: {} }],
    ] as const)('keeps the exit-only refusal with %s', async (_case, country, context) => {
      geo.country.value = country
      geo.context = context
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [refusedIntents.deposit()]))
        .rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
    })

    it('refuses an acquiring intent that names no vault', async () => {
      geo.blocked.mockReturnValue(false)
      const quote = makeSwapQuote()
      const walletSwap = { ...quote, vaultIn: zeroAddress, verify: { ...quote.verify, type: SwapVerificationType.TransferMin, vault: TEST_ACCOUNT, account: zeroAddress } }
      const noVault = intentFor('swap', 'swap-from-wallet', { swapQuote: walletSwap, amount: 1n, tokenIn: TEST_TOKEN })
      expect(collectPlanningRequirements([noVault]).vaults).toEqual([])
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [noVault])).rejects.toThrow(ADDRESS_EXIT_ONLY_MESSAGE)
    })

    it('keeps the regional wording for a real block with the flag down', async () => {
      setAddressExitOnly(false)
      await expect(resolveAppPolicy(makeReviewedExecution().requestSet, 100, [refusedIntents.deposit()]))
        .rejects.toThrow('This operation is not available in your region')
    })
  })
})
