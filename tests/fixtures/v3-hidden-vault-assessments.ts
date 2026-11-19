import { parseVaultAssessment, type EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress, zeroAddress } from 'viem'
import { getVaultVerdictKey, type VaultVerdictLike } from '~/utils/vault-assessment/flagged'
import { liquityHubHiddenVerdict } from '~/tests/fixtures/liquity-hub'

// Raw `/v3/evk/vaults/1/<vault>/assessment` bodies as Euler V3 served them on 2026-11-18, cut to the
// governance findings and the findings that did not pass. Visibility verdicts are from the matching
// `/visibility` reads the same day.

export const IDLE_CREDIT_VAULT = getAddress('0x166d8B62E1748D04eDf39d0078F1Fe4aA01D475E')
export const IDLE_PRODUCT = 'idle-credit-vaults'
export const IDLE_ENTITY = 'idle'
export const IDLE_GOVERNOR = getAddress('0xF02Faf7CFEe786111eaE6747a0c344b48C1eD5E5')
export const EUSDC_95 = getAddress('0x7fAb04FF2717d9A6B71A51c56c29697179597D40')

export const IDLE_CREDIT_VAULT_VERDICT = {
  status: 'hidden',
  decidedBy: 'config-failed',
  reason: 'Governance runs through 0xf02faf…d5e5, a deprecated governor contract.',
  explorableLend: false,
  explorableBorrow: false,
}

export const EUSDC_42_RAW_ASSESSMENT = {
  chainId: 1,
  vaultAddress: '0xc6137BC1378c2396051e06417704d31615F77Cb9',
  configStatus: 'suspended',
  configReason: 'The vault is paused: withdraw, redeem, transfer and 4 more are off, so depositors cannot get out until its governor turns them back on.',
  checksStatus: 'warning',
  consistencyStatus: 'verified',
  consistencyReason: 'Vault ownership and governed product membership are consistent',
  configLastCheckedAt: '2026-11-18T15:13:04.553Z',
  nextCheckAt: '2026-11-18T16:13:04.553Z',
  createdAt: '2026-11-03T20:18:48.903Z',
  configContext: {
    policyId: 'euler-evk',
    outcome: 'fail',
    findings: [
      {
        key: 'hooks.zero-or-trusted',
        outcome: 'fail',
        required: true,
        description: 'Hooked operations require a trusted hook target, or only entry-side operations disabled',
        observed: {
          hookTarget: '0x0000000000000000000000000000000000000000',
          governorAdmin: '0xdd84a24eedde63f10ec3e928f1c8302a47538b6b',
          hookedOperations: ['deposit', 'mint', 'withdraw', 'redeem', 'transfer', 'skim', 'borrow', 'repay', 'repayWithShares', 'pullDebt', 'convertFees', 'liquidate', 'flashloan', 'touch', 'vaultStatusCheck'],
          hookTargetTrusted: false,
        },
        cause: {
          code: 'exit-operations-disabled',
          subject: 'withdraw,redeem,transfer,repay,repayWithShares,liquidate,vaultStatusCheck',
          summary: 'The vault is paused: withdraw, redeem, transfer and 4 more are off, so depositors cannot get out until its governor turns them back on.',
          remedy: 'restore-the-disabled-exit-operations',
        },
      },
      {
        key: 'governance.no-deprecated-governor',
        outcome: 'pass',
        required: true,
        description: 'The vault and its oracle router are not governed by a deprecated governor contract',
        cause: null,
      },
      {
        key: 'collateral.0x5bca378719ad01bb8e490d09e2326edfee66b954.quote',
        outcome: 'fail',
        required: true,
        description: 'The collateral cannot be priced: an adapter on its oracle route reverts for a reason that is not a market closure',
        cause: {
          code: 'session-feed-tolerance-withdrawn',
          subject: '0x5bca378719ad01bb8e490d09e2326edfee66b954',
          summary: '0x5bca37…b954 cannot be priced: an adapter on its oracle route reverts for a reason that is not a market closure.',
          remedy: 'replace-the-oracle-adapter',
        },
      },
      {
        key: 'governance.router',
        outcome: 'pass',
        required: true,
        description: 'The oracle router is ungoverned or governed by the non-zero vault governor',
        cause: null,
      },
      {
        key: 'collateral.0xec91b109817b20d4ebd364a181666327194763f0.recognized',
        outcome: 'fail',
        required: true,
        description: 'The collateral holds a passing Layer 1 verdict under its owning policy',
        cause: {
          code: 'dependency-not-verified',
          subject: '0xec91b109817b20d4ebd364a181666327194763f0',
          summary: 'Collateral 0xec91b1…63f0 does not hold a passing Euler verdict of its own.',
          remedy: 'wait-for-the-dependency-verdict',
        },
      },
      {
        key: 'collateral.0xc1c51c5c9efaf0c485aa1097ae9690b5e102975a.recognized',
        outcome: 'fail',
        required: true,
        description: 'The collateral holds a passing Layer 1 verdict under its owning policy',
        cause: {
          code: 'dependency-not-verified',
          subject: '0xc1c51c5c9efaf0c485aa1097ae9690b5e102975a',
          summary: 'Collateral 0xc1c51c…975a does not hold a passing Euler verdict of its own.',
          remedy: 'wait-for-the-dependency-verdict',
        },
      },
      {
        key: 'collateral.0x5e4cfce564d741373bd0078cb256e94696354c46.recognized',
        outcome: 'fail',
        required: true,
        description: 'The collateral holds a passing Layer 1 verdict under its owning policy',
        cause: {
          code: 'dependency-not-verified',
          subject: '0x5e4cfce564d741373bd0078cb256e94696354c46',
          summary: 'Collateral 0x5e4cfc…4c46 does not hold a passing Euler verdict of its own.',
          remedy: 'wait-for-the-dependency-verdict',
        },
      },
      {
        key: 'collateral.0x5bca378719ad01bb8e490d09e2326edfee66b954.recognized',
        outcome: 'fail',
        required: true,
        description: 'The collateral holds a passing Layer 1 verdict under its owning policy',
        cause: {
          code: 'dependency-not-verified',
          subject: '0x5bca378719ad01bb8e490d09e2326edfee66b954',
          summary: 'Collateral 0x5bca37…b954 does not hold a passing Euler verdict of its own.',
          remedy: 'wait-for-the-dependency-verdict',
        },
      },
      {
        key: 'oracle.adapters-checks',
        outcome: 'fail',
        required: false,
        description: 'The oracle routes include adapters whose own checks are failing',
        cause: {
          code: 'route-adapter-checks-failing',
          subject: '0x94a31084a0e8dbed217ee8763a20ab03e18b38f5',
          summary: 'An adapter on the oracle routes (0x94a310…38f5) has failing checks: quote reverted with PriceOracle_InvalidAnswer, which is not a market closure, the connected price feed is not recognized, adapter...',
          remedy: 'review-the-oracle-adapter',
        },
      },
    ],
  },
  consistencyContext: null,
}

export const IDLE_CREDIT_VAULT_RAW_ASSESSMENT = {
  chainId: 1,
  vaultAddress: '0x166d8B62E1748D04eDf39d0078F1Fe4aA01D475E',
  configStatus: 'unverified',
  configReason: 'Governance runs through 0xf02faf…d5e5, a deprecated governor contract.',
  checksStatus: 'positive',
  consistencyStatus: 'verified',
  consistencyReason: 'Vault ownership and governed product membership are consistent',
  configLastCheckedAt: '2026-11-18T00:44:11.621Z',
  nextCheckAt: '2026-11-19T00:44:11.621Z',
  createdAt: '2026-11-03T19:33:54.105Z',
  configContext: {
    policyId: 'euler-evk',
    outcome: 'fail',
    findings: [
      {
        key: 'governance.no-deprecated-governor',
        outcome: 'fail',
        required: true,
        description: 'The vault and its oracle router are not governed by a deprecated governor contract',
        cause: {
          code: 'deprecated-governor-contract',
          subject: '0xf02faf7cfee786111eae6747a0c344b48c1ed5e5',
          summary: 'Governance runs through 0xf02faf…d5e5, a deprecated governor contract.',
          remedy: 'replace-the-deprecated-governor',
        },
      },
      {
        key: 'governance.router',
        outcome: 'pass',
        required: true,
        description: 'The oracle router is ungoverned or governed by the non-zero vault governor',
        cause: null,
      },
      {
        key: 'collateral.0xd820c8129a853a04dc7e42c64ae62509f531ee5a.recognized',
        outcome: 'fail',
        required: true,
        description: 'The collateral holds a passing Layer 1 verdict under its owning policy',
        cause: {
          code: 'dependency-not-verified',
          subject: '0xd820c8129a853a04dc7e42c64ae62509f531ee5a',
          summary: 'Collateral 0xd820c8…ee5a does not hold a passing Euler verdict of its own.',
          remedy: 'wait-for-the-dependency-verdict',
        },
      },
    ],
  },
  consistencyContext: null,
}

export const EUSDC_95_RAW_ASSESSMENT = {
  chainId: 1,
  vaultAddress: '0x7fAb04FF2717d9A6B71A51c56c29697179597D40',
  configStatus: 'unverified',
  configReason: 'The vault is paused: withdraw, redeem, liquidate are off, so depositors cannot get out until its governor turns them back on.',
  checksStatus: 'positive',
  consistencyStatus: 'verified',
  consistencyReason: 'Vault ownership and governed product membership are consistent',
  configLastCheckedAt: '2026-11-18T16:07:25.849Z',
  nextCheckAt: '2026-11-18T17:07:25.849Z',
  createdAt: '2026-11-03T22:05:57.860Z',
  configContext: {
    policyId: 'euler-evk',
    outcome: 'fail',
    findings: [
      {
        key: 'hooks.zero-or-trusted',
        outcome: 'fail',
        required: true,
        description: 'Hooked operations require a trusted hook target, or only entry-side operations disabled',
        observed: {
          hookTarget: '0x0000000000000000000000000000000000000000',
          governorAdmin: '0xfcad670592a3b24869c0b51a6c6fded4f95d6975',
          hookedOperations: ['deposit', 'mint', 'withdraw', 'redeem', 'borrow', 'liquidate'],
          hookTargetTrusted: false,
        },
        cause: {
          code: 'exit-operations-disabled',
          subject: 'withdraw,redeem,liquidate',
          summary: 'The vault is paused: withdraw, redeem, liquidate are off, so depositors cannot get out until its governor turns them back on.',
          remedy: 'restore-the-disabled-exit-operations',
        },
      },
      {
        key: 'governance.no-deprecated-governor',
        outcome: 'pass',
        required: true,
        description: 'The vault and its oracle router are not governed by a deprecated governor contract',
        cause: null,
      },
      {
        key: 'governance.router',
        outcome: 'pass',
        required: true,
        description: 'The oracle router is ungoverned or governed by the non-zero vault governor',
        cause: null,
      },
    ],
  },
  consistencyContext: null,
}

type RawAssessment = typeof EUSDC_42_RAW_ASSESSMENT | typeof IDLE_CREDIT_VAULT_RAW_ASSESSMENT | typeof EUSDC_95_RAW_ASSESSMENT

/** Stamped with the verdict it was loaded under: eUSDC-42's paused verdict unless another is given. */
export const assessmentEntry = (
  raw: RawAssessment,
  overrides: { consistencyStatus?: string | null, verdict?: VaultVerdictLike } = {},
) => ({
  status: 'available' as const,
  assessment: parseVaultAssessment(raw, raw.chainId, getAddress(raw.vaultAddress), 'evk'),
  consistencyStatus: 'consistencyStatus' in overrides ? overrides.consistencyStatus : raw.consistencyStatus,
  verdictKey: getVaultVerdictKey(overrides.verdict ?? liquityHubHiddenVerdict('config-suspended')),
})

export const makeIdleCreditVault = (): EVault => ({
  type: 'EVault',
  chainId: 1,
  address: IDLE_CREDIT_VAULT,
  asset: { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', decimals: 6, name: 'USD Coin' },
  collaterals: [],
  totalAssets: 0n,
  totalBorrowed: 0n,
  isBorrowable: false,
  governorAdmin: IDLE_GOVERNOR,
  oracle: { oracle: zeroAddress, name: 'EulerRouter' },
  eulerRouterGovernor: IDLE_GOVERNOR,
  hooks: { hookedOperations: {}, hookTarget: zeroAddress },
}) as unknown as EVault
