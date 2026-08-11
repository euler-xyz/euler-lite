import { describe, expect, it } from 'vitest'
import { encodeFunctionData, erc20Abi, parseAbi, type Address } from 'viem'
import type { MigrationAuthorizationRequest } from '@eulerxyz/euler-v2-sdk'

import {
  buildMigrationAuthorizationTxSteps,
  encodeMigrationAuthorizationTxs,
} from '~/utils/migrationAuthorizationTxs'

const owner = '0x0000000000000000000000000000000000000001' as Address
const swapVerifier = '0x0000000000000000000000000000000000000002' as Address
const aToken = '0x0000000000000000000000000000000000000003' as Address
const morphoBlue = '0x0000000000000000000000000000000000000005' as Address

const setAuthorizationAbi = parseAbi([
  'function setAuthorization(address authorized, bool newIsAuthorized)',
])

/** Mirrors AavePositionMigrationConnector.buildATokenApprovalRequest. */
const aaveApprovalRequest = (): MigrationAuthorizationRequest => ({
  kind: 'transaction',
  authorizationType: 'aTokenApproval',
  connectorId: 'aave',
  protocol: 'Aave V3',
  chainId: 1,
  owner,
  token: aToken,
  call: {
    to: aToken,
    abi: erc20Abi,
    functionName: 'approve',
    args: [swapVerifier, 1000n],
  },
  revocation: {
    to: aToken,
    abi: erc20Abi,
    functionName: 'approve',
    args: [swapVerifier, 250n],
  },
} as unknown as MigrationAuthorizationRequest)

/** Mirrors MorphoPositionMigrationConnector.buildAuthorizationTransactionRequest. */
const morphoAuthorizationRequest = (): MigrationAuthorizationRequest => ({
  kind: 'transaction',
  authorizationType: 'morphoAuthorization',
  connectorId: 'morpho',
  protocol: 'Morpho',
  chainId: 1,
  owner,
  call: {
    to: morphoBlue,
    abi: setAuthorizationAbi,
    functionName: 'setAuthorization',
    args: [swapVerifier, true],
  },
  revocation: {
    to: morphoBlue,
    abi: setAuthorizationAbi,
    functionName: 'setAuthorization',
    args: [swapVerifier, false],
  },
} as unknown as MigrationAuthorizationRequest)

const typedDataRequest = (): MigrationAuthorizationRequest => ({
  kind: 'typedData',
  connectorId: 'aave',
  protocol: 'Aave V3',
  chainId: 1,
  owner,
  typedData: {
    domain: { verifyingContract: aToken, chainId: 1 },
    types: { Permit: [] },
    primaryType: 'Permit',
    message: { owner, spender: swapVerifier, value: 1000n },
  },
} as unknown as MigrationAuthorizationRequest)

describe('encodeMigrationAuthorizationTxs', () => {
  it('encodes an Aave approval grant and restores the previous allowance', () => {
    const { grants, revokes } = encodeMigrationAuthorizationTxs(aaveApprovalRequest())

    expect(grants).toEqual([{
      to: aToken,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swapVerifier, 1000n] }),
    }])
    expect(revokes).toEqual([{
      to: aToken,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swapVerifier, 250n] }),
    }])
  })

  it('encodes a Morpho enable grant and restores its disabled state', () => {
    const { grants, revokes } = encodeMigrationAuthorizationTxs(morphoAuthorizationRequest())

    expect(grants[0]!.data).toBe(
      encodeFunctionData({ abi: setAuthorizationAbi, functionName: 'setAuthorization', args: [swapVerifier, true] }),
    )
    expect(revokes[0]!.data).toBe(
      encodeFunctionData({ abi: setAuthorizationAbi, functionName: 'setAuthorization', args: [swapVerifier, false] }),
    )
  })

  it('unwinds chained authorizations in reverse grant order', () => {
    const request = {
      ...aaveApprovalRequest(),
      postMigrationAuthorization: morphoAuthorizationRequest(),
    } as unknown as MigrationAuthorizationRequest

    const { grants, revokes, revokesByGrant } = encodeMigrationAuthorizationTxs(request)

    expect(grants.map(tx => tx.to)).toEqual([aToken, morphoBlue])
    // A later grant must never depend on an earlier restoration.
    expect(revokes.map(tx => tx.to)).toEqual([morphoBlue, aToken])
    expect(revokesByGrant.map(tx => tx?.to)).toEqual([aToken, morphoBlue])
  })

  it('omits restoration when the request carries none', () => {
    const request = { ...aaveApprovalRequest(), revocation: undefined } as unknown as MigrationAuthorizationRequest

    const { grants, revokes, revokesByGrant } = encodeMigrationAuthorizationTxs(request)

    expect(grants).toHaveLength(1)
    expect(revokes).toEqual([])
    expect(revokesByGrant).toEqual([undefined])
  })

  it('preserves a call value when present', () => {
    const request = {
      ...aaveApprovalRequest(),
      call: { to: aToken, abi: erc20Abi, functionName: 'approve', args: [swapVerifier, 1000n], value: 5n },
    } as unknown as MigrationAuthorizationRequest

    expect(encodeMigrationAuthorizationTxs(request).grants[0]!.value).toBe(5n)
  })

  it('rejects a typed-data request, which must be signed rather than sent', () => {
    expect(() => encodeMigrationAuthorizationTxs(typedDataRequest()))
      .toThrow(/not requested in transaction form/)
  })
})

describe('buildMigrationAuthorizationTxSteps', () => {
  it('labels grant and restoration rows per connector', () => {
    expect(buildMigrationAuthorizationTxSteps(aaveApprovalRequest(), 'grant')).toEqual([
      { index: 1, label: 'Approve aToken transfer', isSeparateTx: true },
    ])
    expect(buildMigrationAuthorizationTxSteps(morphoAuthorizationRequest(), 'revoke', 4)).toEqual([
      { index: 4, label: 'Restore previous Morpho authorization', isSeparateTx: true },
    ])
  })

  it('orders restoration rows to match the transactions actually sent', () => {
    const request = {
      ...aaveApprovalRequest(),
      postMigrationAuthorization: morphoAuthorizationRequest(),
    } as unknown as MigrationAuthorizationRequest

    expect(buildMigrationAuthorizationTxSteps(request, 'revoke').map(step => step.label)).toEqual([
      'Restore previous Morpho authorization',
      'Restore previous aToken approval',
    ])
  })

  it('falls back to a generic label for an unknown authorization type', () => {
    const request = { ...aaveApprovalRequest(), authorizationType: 'somethingNew' } as unknown as MigrationAuthorizationRequest

    expect(buildMigrationAuthorizationTxSteps(request, 'grant')[0]!.label).toBe('Approve migration')
    expect(buildMigrationAuthorizationTxSteps(request, 'revoke')[0]!.label).toBe('Restore previous migration authorization')
  })

  it('renders nothing for a typed-data request or no request', () => {
    expect(buildMigrationAuthorizationTxSteps(typedDataRequest(), 'grant')).toEqual([])
    expect(buildMigrationAuthorizationTxSteps(undefined, 'grant')).toEqual([])
  })

  it('marks rows as same-submission when bundled into a Safe proposal', () => {
    const request = aaveApprovalRequest() as unknown as MigrationAuthorizationRequest

    expect(buildMigrationAuthorizationTxSteps(request, 'grant', 1, { bundled: true })[0]!.isSeparateTx).toBe(false)
    expect(buildMigrationAuthorizationTxSteps(request, 'revoke', 1, { bundled: true })[0]!.isSeparateTx).toBe(false)
    // Default stays standalone.
    expect(buildMigrationAuthorizationTxSteps(request, 'grant')[0]!.isSeparateTx).toBe(true)
  })
})
