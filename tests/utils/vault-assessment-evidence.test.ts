import type { VaultAssessment, VaultAssessmentFinding } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  getAssessmentSafeEvidence,
  getEarnAllocatorAddresses,
  getRouterGovernorEvidence,
  getUpgradeabilityEvidence,
} from '~/utils/vault-assessment/evidence'

const owner = getAddress('0x00000000000000000000000000000000000000aa')
const signer = getAddress('0x00000000000000000000000000000000000000bb')
const implementation = getAddress('0x00000000000000000000000000000000000000cc')

const assessmentWith = (findings: Array<Pick<VaultAssessmentFinding, 'key' | 'observed'>>): VaultAssessment => ({
  chainId: 1,
  vaultAddress: '0x00000000000000000000000000000000000000dd',
  family: 'earn',
  configStatus: 'verified',
  checksStatus: 'positive',
  configReason: null,
  consistencyReason: null,
  configContext: {
    findings: findings.map(finding => ({
      ...finding,
      outcome: 'not_applicable',
      required: false,
      description: '',
      cause: null,
    })),
  },
  consistencyContext: null,
  configLastCheckedAt: null,
  nextCheckAt: null,
  createdAt: null,
  assessed: true,
})

describe('vault assessment evidence', () => {
  it('uses validated V3 Safe thresholds and allocator addresses', () => {
    const assessment = assessmentWith([{
      key: 'evidence.multisig',
      observed: {
        owner: { address: owner, safe: { threshold: '1', owners: [signer] } },
        allocators: [{ address: owner, safe: null }, { address: signer, safe: null }],
      },
    }])
    expect(getAssessmentSafeEvidence(assessment, owner)).toEqual({ threshold: 1, owners: [signer] })
    expect(getEarnAllocatorAddresses(assessment)).toEqual([owner, signer])
  })

  it('includes V3 unprobed allocator addresses', () => {
    const assessment = assessmentWith([{
      key: 'evidence.multisig',
      observed: {
        allocators: [{ address: owner, safe: null }],
        unprobedAllocators: [signer.toLowerCase(), owner.toLowerCase(), 'invalid'],
      },
    }])
    expect(getEarnAllocatorAddresses(assessment)).toEqual([owner, signer])
    expect(getAssessmentSafeEvidence(assessment, signer)).toBeUndefined()
  })

  it('distinguishes a confirmed non-Safe from absent or malformed evidence', () => {
    const assessment = assessmentWith([{
      key: 'evidence.multisig',
      observed: { owner: { address: owner, safe: null } },
    }])
    expect(getAssessmentSafeEvidence(assessment, owner)).toBeNull()
    expect(getAssessmentSafeEvidence(undefined, owner)).toBeUndefined()
    expect(getAssessmentSafeEvidence(assessment, signer)).toBeUndefined()
    const invalid = assessmentWith([{
      key: 'evidence.multisig',
      observed: { owner: { address: owner, safe: { threshold: '2', owners: [signer] } } },
    }])
    expect(getAssessmentSafeEvidence(invalid, owner)).toBeUndefined()
  })

  it('shows upgradeability only when V3 supplies a boolean verdict', () => {
    const assessment = assessmentWith([{
      key: 'evidence.upgradeable',
      observed: { upgradeable: true, implementation },
    }])
    expect(getUpgradeabilityEvidence(assessment)).toEqual({ upgradeable: true, implementation })
    expect(getUpgradeabilityEvidence(assessmentWith([{
      key: 'evidence.upgradeable',
      observed: { implementation },
    }]))).toBeNull()
  })

  it('uses a valid router governor from assessment evidence', () => {
    const assessment = assessmentWith([{
      key: 'evidence.governance',
      observed: { routerGovernor: owner },
    }])
    expect(getRouterGovernorEvidence(assessment)).toBe(owner)
    expect(getRouterGovernorEvidence(assessmentWith([{
      key: 'evidence.governance',
      observed: { routerGovernor: 'invalid' },
    }]))).toBeUndefined()
  })
})
