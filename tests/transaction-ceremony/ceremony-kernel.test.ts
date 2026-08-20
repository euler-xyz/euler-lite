import { encodeFunctionData, getAddress, keccak256, toHex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { EVC_ABI } from '~/abis/evc'
import type { EvidenceState, SealedPluginEnvelope } from '~/features/transaction-ceremony/domain/ceremony'
import { digestPluginPlan, sealCeremony } from '~/features/transaction-ceremony/domain/seal'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import type { WalletBinding } from '~/features/transaction-ceremony/domain/template'
import { validateExecutionTemplate, validateIntentSet } from '~/features/transaction-ceremony/domain/validators'
import { connectorSessionDigest } from '~/features/transaction-ceremony/domain/wallet-session'
import { materializePreparedPlan, executionTemplateDigest } from '~/features/transaction-ceremony/materialization/prepared-plan'
import { PreparationCache, type PreparationCacheIdentity } from '~/features/transaction-ceremony/planning/cache'
import { assertPolicyEvidenceVersionsMatch, buildPolicyEvidence, collectPolicyRequirements, collectPolicySubjects, type PolicyEvidenceInput } from '~/features/transaction-ceremony/policy/engine'
import { buildSimulationCertificate, validateSimulationCoverage } from '~/features/transaction-ceremony/simulation/coverage'

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

const allowed = (version = 'v1'): EvidenceState => ({ state: 'allowed', version, observedAt: 1, expiresAt: 10_000 })

const evidenceFor = (template: ReturnType<typeof materializePreparedPlan>): PolicyEvidenceInput[] =>
  collectPolicyRequirements(template).map(requirement => ({ ...requirement, result: allowed() }))

describe('ceremony semantic kernel', () => {
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

  it('derives policy subjects from the final effect graph and fails closed', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: keccak256(toHex('pending')) })
    const subjects = collectPolicySubjects(preliminary)
    expect(subjects).toEqual(expect.arrayContaining([
      { kind: 'account', value: ACCOUNT },
      { kind: 'asset', value: TOKEN },
      { kind: 'vault-or-contract', value: VAULT },
    ]))
    expect(() => buildPolicyEvidence({ template: preliminary, evidence: [], now: 10 })).toThrow(/missing|is/)
    const pendingEvidence = evidenceFor(preliminary)
    pendingEvidence[0] = { ...pendingEvidence[0], result: { state: 'pending', version: 'v1' } }
    expect(() => buildPolicyEvidence({ template: preliminary, evidence: pendingEvidence, now: 10 })).toThrow(/pending/)
    const missingAsset = {
      ...preliminary,
      effects: preliminary.effects.map(effect => ({
        ...effect,
        policySubjects: effect.policySubjects.filter(subject => subject.kind !== 'asset'),
      })),
    }
    expect(() => validateExecutionTemplate(missingAsset, [intent])).toThrow(/omits policy subject/)
    expect(() => buildPolicyEvidence({ template: preliminary, evidence: [...evidenceFor(preliminary), evidenceFor(preliminary)[0]!], now: 10 })).toThrow(/duplicated/)
  })

  it('rejects policy source-version drift even when current evidence remains allowed', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: keccak256(toHex('pending')) })
    const sealed = buildPolicyEvidence({ template: preliminary, evidence: evidenceFor(preliminary), now: 10 })
    const currentEvidence = evidenceFor(preliminary)
    currentEvidence[0] = { ...currentEvidence[0]!, result: allowed('v2') }
    const current = buildPolicyEvidence({ template: preliminary, evidence: currentEvidence, now: 20 })

    expect(() => assertPolicyEvidenceVersionsMatch(sealed, sealed)).not.toThrow()
    expect(() => assertPolicyEvidenceVersionsMatch(sealed, current)).toThrow(/source versions changed/)
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

  it('seals one digest across template, simulation, manifest, and review binding', () => {
    const preliminary = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: keccak256(toHex('pending')) })
    const policy = buildPolicyEvidence({ template: preliminary, evidence: evidenceFor(preliminary), now: 10 })
    const template = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: policy.digest })
    validateExecutionTemplate(template, [intent])
    const templateDigest = executionTemplateDigest(template)
    const simulation = buildSimulationCertificate({
      template,
      templateDigest,
      observedAt: 10,
      projection: { canExecute: true, simulatedAccounts: [], simulatedVaults: [], blockNumber: 100n },
    })
    const rawPlan = [{ type: 'evcBatch', items: [] }] as const
    const plugins: SealedPluginEnvelope = {
      rawPlan: rawPlan as never,
      previewPlan: rawPlan as never,
      rawPlanDigest: digestPluginPlan('raw', rawPlan as never),
      previewPlanDigest: digestPluginPlan('preview', rawPlan as never),
      pluginConfigurationDigest: digestPluginPlan('configuration', { plugins: ['tos', 'keyring', 'pyth'] }),
    }
    const ceremony = sealCeremony({
      intents: [intent],
      template,
      policyEvidence: policy,
      simulation,
      plugins,
      validity: { createdAt: 10, expiresAt: 1000, cartGeneration: 1, planningSnapshotDigest: keccak256(toHex('snapshot')), policyVersionDigest: keccak256(toHex('policy-version')) },
      presentationKind: 'supply',
      presentationInputs: { type: 'supply', amount: '10', symbol: 'USDC' },
    })

    expect(ceremony.templateDigest).toBe(templateDigest)
    expect(ceremony.simulation.templateDigest).toBe(templateDigest)
    expect(ceremony.internalManifest.templateDigest).toBe(templateDigest)
    expect(ceremony.reviewBinding.ceremonyId).toBe(ceremony.ceremonyId)
    expect(ceremony.internalManifest.entries).toHaveLength(template.effects.length)
    expect(Object.isFrozen(ceremony)).toBe(true)
  })

  it('rejects mixed independent-direct and EVC coverage', () => {
    const template = materializePreparedPlan({ intents: [intent], plan, wallet, sdk, policyEvidenceDigest: keccak256(toHex('policy')) })
    const mixed = {
      ...template,
      effects: [
        ...template.effects,
        { ...template.effects[0], effectId: keccak256(toHex('direct')), effect: { kind: 'direct-call' as const, chainId: 1, target: VAULT, value: 0n, data: '0x12345678' as const, selector: '0x12345678' as const }, simulation: { kind: 'independent-call' as const } },
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
    templateDigest: keccak256(toHex('template')),
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
    ['templateDigest', keccak256(toHex('other-template'))],
  ] as const)('rejects %s drift without discarding the matching record', (key, value) => {
    const cache = new PreparationCache()
    cache.put(identity, { hit: true })
    expect(cache.get({ ...identity, [key]: value }, 999)).toBeUndefined()
    expect(cache.get(identity, 999)).toEqual({ hit: true })
  })
})
