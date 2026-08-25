import { encodeFunctionData, getAddress, keccak256, toHex, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { PolicyState, PluginSnapshot, WalletBinding } from '~/features/reviewed-execution/domain/reviewed-execution'
import { digestPluginPlan, sealReviewedExecution } from '~/features/reviewed-execution/domain/seal'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { validateReviewedRequestSet, validateIntentSet } from '~/features/reviewed-execution/domain/validators'
import { connectorSessionDigest } from '~/features/reviewed-execution/domain/wallet-session'
import { materializePreparedPlan, reviewedRequestDigest } from '~/features/reviewed-execution/materialization/prepared-plan'
import { PreparationCache, type PreparationCacheIdentity } from '~/features/reviewed-execution/planning/cache'
import { assertPolicyVersionsMatch, buildReviewedPolicy, collectPolicyRequirements, collectPolicySubjects, type PolicyResultInput } from '~/features/reviewed-execution/policy/engine'
import { buildReviewedSimulation, validateSimulationCoverage } from '~/features/reviewed-execution/simulation/coverage'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { makeSwapQuote } from './swap-quote.test-fixture'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const TOKEN = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const EVC = getAddress('0x4000000000000000000000000000000000000000')

const intent: OperationIntent = {
  schemaVersion: 1,
  intentId: 'intent-1',
  revision: 1,
  kind: 'deposit',
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  planner: { name: 'deposit', args: { vaultAddress: VAULT, assetAddress: TOKEN, amount: 10n } },
  constraints: [{ kind: 'exact-input', token: TOKEN, amount: 10n }],
  metadata: { createdAt: 1, source: 'test' },
}

const wallet: WalletBinding = {
  chainId: 1,
  account: ACCOUNT,
  subAccounts: [ACCOUNT],
  connectorId: 'injected',
  connectorSessionId: 'session-1',
  walletKind: 'eoa',
  classificationVersion: 'classification-1',
  approvalMode: 'approve',
}

const sdk = {
  deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }) },
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] }),
  },
}

const plan: TransactionPlan = [{
  type: 'evcBatch',
  items: [{ targetContract: VAULT, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x12345678' }],
}]

const allowed = (version = 'v1'): PolicyState => ({ state: 'allowed', version, observedAt: 1, expiresAt: 10_000 })

const policyResultsFor = (requestSet: ReturnType<typeof materializePreparedPlan>): PolicyResultInput[] =>
  collectPolicyRequirements(requestSet).map(requirement => ({ ...requirement, result: allowed() }))

describe('reviewed execution semantic kernel', () => {
  it('rejects unbounded variable intents and mixed contexts', () => {
    expect(() => validateIntentSet([{ ...intent, constraints: [] }])).toThrow(/no bounded outcome/)
    expect(() => validateIntentSet([intent, { ...intent, intentId: 'intent-2', account: VAULT }])).toThrow(/mixes wallet/)
  })

  it('rejects a display constraint that does not match the public planner input', () => {
    expect(() => validateIntentSet([{
      ...intent,
      constraints: [{ kind: 'exact-input', token: TOKEN, amount: 9n }],
    }])).toThrow(/planner-enforced exact-input/)
  })

  it('rejects a swap-and-borrow intent that would encode a zero borrow', () => {
    const quote = makeSwapQuote()
    const zeroBorrow = createOperationIntent({
      kind: 'borrow',
      planner: 'swap-and-borrow',
      args: {
        swapQuote: quote,
        amount: 10n,
        tokenIn: TOKEN,
        borrowVault: VAULT,
        collateralVault: quote.tokenOut.address,
        borrowAmount: 0n,
        borrowAccount: ACCOUNT,
      },
      chainId: 1,
      account: ACCOUNT,
      source: 'test',
      createdAt: 1,
      intentId: 'intent-zero-swap-borrow',
    })

    expect(() => validateIntentSet([zeroBorrow])).toThrow(/has no borrow amount/)
  })

  it('derives policy inputs from every finalized call and fails closed', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyDigest: keccak256(toHex('pending')) })
    const subjects = collectPolicySubjects(preliminary)
    expect(subjects).toEqual(expect.arrayContaining([
      { kind: 'account', value: ACCOUNT },
      { kind: 'asset', value: TOKEN },
      { kind: 'vault-or-contract', value: VAULT },
    ]))
    expect(() => buildReviewedPolicy({ requestSet: preliminary, results: [], now: 10 })).toThrow(/missing|is/)
    const pendingResults = policyResultsFor(preliminary)
    pendingResults[0] = { ...pendingResults[0], result: { state: 'pending', version: 'v1' } }
    expect(() => buildReviewedPolicy({ requestSet: preliminary, results: pendingResults, now: 10 })).toThrow(/pending/)
    const missingAsset = {
      ...preliminary,
      effects: preliminary.effects.map(effect => ({
        ...effect,
        policySubjects: effect.policySubjects.filter(subject => subject.kind !== 'asset'),
      })),
    }
    expect(() => validateReviewedRequestSet(missingAsset, [intent])).toThrow(/omits policy subject/)
    expect(() => buildReviewedPolicy({ requestSet: preliminary, results: [...policyResultsFor(preliminary), policyResultsFor(preliminary)[0]!], now: 10 })).toThrow(/duplicated/)
  })

  it('binds all normalized accounts without adding derived-address screening requirements', () => {
    const owner = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
    const subAccount = getAddress('0x1234567890abcdef1234567890abcdef12345678')
    const multiAccountIntent: OperationIntent = {
      ...intent,
      account: owner,
      subAccounts: [owner, subAccount],
    }
    const multiAccountWallet: WalletBinding = {
      ...wallet,
      account: owner,
      subAccounts: [owner, subAccount],
    }
    const sentinelPlan: TransactionPlan = [{
      type: 'evcBatch',
      items: [{ targetContract: VAULT, onBehalfOfAccount: zeroAddress, value: 0n, data: '0x12345678' }],
    }]

    const requestSet = materializePreparedPlan({
      intents: [multiAccountIntent],
      plan: sentinelPlan,
      wallet: multiAccountWallet,
      sdk,
      policyDigest: keccak256(toHex('pending')),
    })

    expect(collectPolicySubjects(requestSet)).toEqual(expect.arrayContaining([
      { kind: 'account', value: owner },
      { kind: 'account', value: subAccount },
    ]))
    expect(collectPolicyRequirements(requestSet).filter(requirement => requirement.subject.startsWith('account:'))).toEqual([])
    expect(collectPolicySubjects(requestSet)).not.toContainEqual({ kind: 'account', value: zeroAddress })
  })

  it('rejects policy source-version drift even when current evidence remains allowed', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyDigest: keccak256(toHex('pending')) })
    const sealed = buildReviewedPolicy({ requestSet: preliminary, results: policyResultsFor(preliminary), now: 10 })
    const currentResults = policyResultsFor(preliminary)
    currentResults[0] = { ...currentResults[0]!, result: allowed('v2') }
    const current = buildReviewedPolicy({ requestSet: preliminary, results: currentResults, now: 20 })

    expect(() => assertPolicyVersionsMatch(sealed, sealed)).not.toThrow()
    expect(() => assertPolicyVersionsMatch(sealed, current)).toThrow(/source versions changed/)
  })

  it('uses stable connector identity across app boots and binds session-topic changes', () => {
    const identity = {
      connectorId: 'walletConnect',
      connectorName: 'WalletConnect',
      connectorType: 'walletConnect',
      sessionTopic: 'topic-1',
      pairingTopic: 'pairing-1',
      peerName: 'Safe',
      peerUrl: 'https://app.safe.global',
    }
    expect(connectorSessionDigest(identity)).toBe(connectorSessionDigest({ ...identity }))
    expect(connectorSessionDigest(identity)).not.toBe(connectorSessionDigest({ ...identity, sessionTopic: 'topic-2' }))
  })

  it('seals one digest across the request set, simulation, decoded calls, and review binding', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyDigest: keccak256(toHex('pending')) })
    const policy = buildReviewedPolicy({ requestSet: preliminary, results: policyResultsFor(preliminary), now: 10 })
    const requestSet = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyDigest: policy.digest })
    validateReviewedRequestSet(requestSet, [intent])
    const requestDigest = reviewedRequestDigest(requestSet)
    const simulation = buildReviewedSimulation({
      requestSet,
      requestDigest,
      observedAt: 10,
      projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [], blockNumber: 100n },
    })
    const rawPlan = [{ type: 'evcBatch', items: [] }] as const
    const plugins: PluginSnapshot = {
      rawPlan: rawPlan as never,
      previewPlan: rawPlan as never,
      rawPlanDigest: digestPluginPlan('raw', rawPlan as never),
      previewPlanDigest: digestPluginPlan('preview', rawPlan as never),
      pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
    }
    const execution = sealReviewedExecution({
      intents: [intent],
      requestSet: requestSet,
      policy: policy,
      simulation,
      pluginSnapshot: plugins,
      validity: { createdAt: 10, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy-version')) },
      presentationKind: 'supply',
      presentationInputs: { type: 'supply', amount: '10', symbol: 'USDC' },
    })

    expect(execution.requestDigest).toBe(requestDigest)
    expect(execution.simulation.requestDigest).toBe(requestDigest)
    expect(execution.effectMap.requestDigest).toBe(requestDigest)
    expect(execution.binding.reviewId).toBe(execution.reviewId)
    expect(execution.effectMap.entries).toHaveLength(requestSet.effects.length)
    expect(Object.isFrozen(execution)).toBe(true)
  })

  it('rejects mixed independent-direct and EVC coverage', () => {
    const requestSet = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyDigest: keccak256(toHex('policy')) })
    const mixed = {
      ...requestSet,
      effects: [
        ...requestSet.effects,
        { ...requestSet.effects[0], effectId: keccak256(toHex('direct')), effect: { kind: 'direct-call' as const, chainId: 1, target: VAULT, value: 0n, data: '0x12345678' as const, selector: '0x12345678' as const }, simulation: { kind: 'independent-call' as const } },
      ],
    }
    expect(() => validateSimulationCoverage(mixed)).toThrow(/direct-only/)
  })
})

describe('generation-bound preparation cache', () => {
  const identity: PreparationCacheIdentity = {
    schemaVersion: 1,
    stage: 'whole-cart-simulation',
    intentSetHash: keccak256(toHex('intents')),
    cartGeneration: 2,
    owner: ACCOUNT,
    chainId: 1,
    accounts: [ACCOUNT],
    connectorId: 'injected',
    connectorSessionId: 'session-1',
    observedBlock: 100n,
    dataSourceVersions: { rpc: '100', labels: 'v1' },
    compilerVersion: 'compiler-1',
    policyVersionDigest: keccak256(toHex('policy-v1')),
    requestDigest: keccak256(toHex('requestSet')),
    freshUntil: 1000,
  }

  it('adopts only a complete exact identity that is still fresh', () => {
    const cache = new PreparationCache()
    cache.put(identity, { simulation: 'exact-whole-cart' })
    expect(cache.get(identity, 999)).toEqual({ simulation: 'exact-whole-cart' })
    expect(cache.get({ ...identity, cartGeneration: 3 }, 999)).toBeUndefined()
    expect(cache.get({ ...identity, connectorSessionId: 'session-2' }, 999)).toBeUndefined()
    expect(cache.get({ ...identity, observedBlock: 101n }, 999)).toBeUndefined()
    expect(cache.get(identity, 1000)).toBeUndefined()
  })

  it.each([
    ['owner', VAULT],
    ['chainId', 2],
    ['intentSetHash', keccak256(toHex('other'))],
    ['compilerVersion', 'compiler-2'],
    ['requestDigest', keccak256(toHex('other-request-set'))],
  ] as const)('rejects %s drift without discarding the matching record', (key, value) => {
    const cache = new PreparationCache()
    cache.put(identity, { hit: true })
    expect(cache.get({ ...identity, [key]: value }, 999)).toBeUndefined()
    expect(cache.get(identity, 999)).toEqual({ hit: true })
  })
})
