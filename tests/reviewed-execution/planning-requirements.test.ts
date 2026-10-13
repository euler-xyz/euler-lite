import { getAddress, zeroAddress, zeroHash, type Address } from 'viem'
import { SwapVerificationType, type Account, type IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { createAppSnapshotDependencies } from '~/features/reviewed-execution/planning/app-snapshot'
import { GenerationPublisher, PreparationCache } from '~/features/reviewed-execution/planning/cache'
import { collectPlanningRequirements } from '~/features/reviewed-execution/planning/requirements'
import { PlanningSnapshotLoader } from '~/features/reviewed-execution/planning/snapshot-loader'
import { TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

const TARGET_VAULT = getAddress('0x5000000000000000000000000000000000000000')
const SWAP_VERIFIER = getAddress('0x6000000000000000000000000000000000000000')
const EXTERNAL_VAULT = getAddress('0x7000000000000000000000000000000000000000')
const OUTPUT_TOKEN = getAddress('0x8000000000000000000000000000000000000000')
const TRANSFER_PLANNERS = ['withdraw-and-swap', 'redeem-and-swap', 'swap-from-wallet', 'cross-protocol-migration'] as const
type TransferPlanner = typeof TRANSFER_PLANNERS[number]

const transferIntent = (planner: TransferPlanner, recipient?: Address) => {
  const migration = planner === 'cross-protocol-migration'
  const walletSwap = planner === 'swap-from-wallet'
  const receiver = recipient ?? (migration ? SWAP_VERIFIER : TEST_ACCOUNT)
  const quote = makeSwapQuote()
  const swapQuote = {
    ...quote,
    accountIn: migration || walletSwap ? zeroAddress : TEST_ACCOUNT,
    accountOut: zeroAddress,
    vaultIn: migration || walletSwap ? zeroAddress : TEST_VAULT,
    receiver,
    tokenOut: { ...quote.tokenOut, address: OUTPUT_TOKEN },
    transferOutputToReceiver: true,
    verify: {
      ...quote.verify,
      verifierAddress: SWAP_VERIFIER,
      type: SwapVerificationType.TransferMin,
      vault: receiver,
      account: zeroAddress,
    },
  }
  const args = migration
    ? {
        direction: 'external-to-euler',
        connectorId: 'metamorpho',
        owner: TEST_ACCOUNT,
        positionRef: { vault: EXTERNAL_VAULT, version: 'v1' },
        target: { eulerAccount: TEST_ACCOUNT, collateralVault: TEST_VAULT, collateralSwapVerification: 'deposit' },
        collateralSwapQuote: swapQuote,
        deadline: BigInt(quote.verify.deadline),
        authorizationEvidenceDigest: zeroHash,
      }
    : walletSwap
      ? { swapQuote, amount: 10n, tokenIn: TEST_TOKEN }
      : {
          swapQuote, vaultAddress: TEST_VAULT, owner: TEST_ACCOUNT,
          ...(planner === 'redeem-and-swap' ? { shares: 10n } : { assets: 10n }),
        }
  return createOperationIntent({
    kind: migration ? 'migration' : walletSwap ? 'swap' : 'withdraw',
    planner,
    args,
    chainId: 1,
    account: TEST_ACCOUNT,
    source: 'test',
    ...(migration ? { constraints: [{ kind: 'maximum-input' as const, token: TEST_TOKEN, amount: 10n }] } : {}),
  })
}

const availableVaults = new Set<Address>()
const getOrFetch = vi.fn(async (address: Address) => availableVaults.has(address)
  ? {
      chainId: 1, address,
      asset: { address: TEST_TOKEN, symbol: 'TEST', decimals: 18 },
      totalShares: 100n, totalAssets: 100n,
    }
  : undefined)

const loadSnapshot = (intents: readonly OperationIntent[]) => {
  const generation = new GenerationPublisher()
  const loader = new PlanningSnapshotLoader(new PreparationCache(), createAppSnapshotDependencies({
    account: { chainId: 1, owner: TEST_ACCOUNT, subAccounts: {} } as Account<IHasVaultAddress>,
    getBlockNumber: async () => 100n,
    dataVersion: 'data-v1',
    labelsVersion: 'labels-v1',
  }), generation, 'compiler-v1')
  return loader.load(collectPlanningRequirements(intents), generation.current())
}

describe('swap planning requirements', () => {
  beforeEach(() => {
    availableVaults.clear()
    availableVaults.add(TEST_VAULT)
    availableVaults.add(TARGET_VAULT)
    getOrFetch.mockClear()
    vi.stubGlobal('useVaultRegistry', () => ({
      getOrFetch,
      getType: (address: Address) => availableVaults.has(address) ? 'evk' : undefined,
    }))
    vi.stubGlobal('useTokenList', () => ({ getTokenByAddress: () => undefined }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(TRANSFER_PLANNERS)('loads %s snapshots without treating the transfer recipient as a vault', async (planner) => {
    const intent = transferIntent(planner)
    const recipient = planner === 'cross-protocol-migration' ? SWAP_VERIFIER : TEST_ACCOUNT
    const expectedVaults = planner === 'swap-from-wallet' ? [] : [TEST_VAULT]

    await expect(loadSnapshot([intent])).resolves.toMatchObject({ observedBlock: 100n })
    const requirements = collectPlanningRequirements([intent])
    expect(requirements.vaults).toEqual(expectedVaults)
    expect(requirements.accounts).toContain(recipient)
    expect(requirements.assets).toContain(TEST_TOKEN)
    expect([...requirements.accounts, ...requirements.vaults, ...requirements.assets]).not.toContain(zeroAddress)
    expect(getOrFetch.mock.calls.map(([address]) => address)).toEqual(expectedVaults)
  })

  it.each(['withdraw-and-swap', 'redeem-and-swap', 'cross-protocol-migration'] as const)(
    'requires the real vault snapshot for %s', async (planner) => {
      availableVaults.delete(TEST_VAULT)

      await expect(loadSnapshot([transferIntent(planner)])).rejects.toThrow(`Vault snapshot is unavailable for ${TEST_VAULT}`)
    },
  )

  it.each([SwapVerificationType.SkimMin, SwapVerificationType.DebtMax])(
    'loads and requires both vault snapshots for %s verification', async (type) => {
      const quote = makeSwapQuote()
      const intent = createOperationIntent({
        kind: 'swap',
        planner: type === SwapVerificationType.SkimMin ? 'swap-collateral' : 'swap-debt',
        args: {
          swapQuote: {
            ...quote,
            receiver: TARGET_VAULT,
            tokenOut: { ...quote.tokenOut, address: OUTPUT_TOKEN },
            verify: { ...quote.verify, type, vault: TARGET_VAULT },
          },
          swapperMode: 0,
        },
        chainId: 1,
        account: TEST_ACCOUNT,
        source: 'test',
      })

      expect(collectPlanningRequirements([intent]).vaults).toEqual([TEST_VAULT, TARGET_VAULT])
      await expect(loadSnapshot([intent])).resolves.toMatchObject({ observedBlock: 100n })
      expect(getOrFetch.mock.calls.map(([address]) => address)).toEqual([TEST_VAULT, TARGET_VAULT])

      availableVaults.delete(TARGET_VAULT)
      await expect(loadSnapshot([intent])).rejects.toThrow(`Vault snapshot is unavailable for ${TARGET_VAULT}`)
    },
  )

  it.each([false, true])('preserves an independent vault reference to a transfer recipient, transferFirst=%s', async (transferFirst) => {
    const transfer = transferIntent('swap-from-wallet', TARGET_VAULT)
    const deposit = createOperationIntent({
      kind: 'deposit',
      planner: 'deposit',
      args: { vaultAddress: TARGET_VAULT, assetAddress: TEST_TOKEN, amount: 10n },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'test',
    })
    const intents = transferFirst ? [transfer, deposit] : [deposit, transfer]

    expect(collectPlanningRequirements(intents).vaults).toEqual([TARGET_VAULT])
    await expect(loadSnapshot(intents)).resolves.toMatchObject({ observedBlock: 100n })
    expect(getOrFetch).toHaveBeenCalledExactlyOnceWith(TARGET_VAULT)

    availableVaults.delete(TARGET_VAULT)
    await expect(loadSnapshot(intents)).rejects.toThrow(`Vault snapshot is unavailable for ${TARGET_VAULT}`)
  })

  it('loads a mixed transferMin cart with only its real vault dependencies', async () => {
    const intents = TRANSFER_PLANNERS.map(planner => transferIntent(planner))

    await expect(loadSnapshot(intents)).resolves.toMatchObject({ observedBlock: 100n })
    expect(collectPlanningRequirements(intents).vaults).toEqual([TEST_VAULT])
    expect(getOrFetch).toHaveBeenCalledExactlyOnceWith(TEST_VAULT)
  })
})
