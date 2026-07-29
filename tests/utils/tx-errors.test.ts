import { afterEach, describe, it, expect } from 'vitest'
import { ContractFunctionRevertedError, encodeAbiParameters, type Hex } from 'viem'
import {
  formatSimulationFailure,
  getTxErrorCode,
  getTxErrorMessage,
  isNonBlockingApprovalSimulationError,
  isNonBlockingApprovalSimulationFailure,
  shouldDiscardQuoteOnEstimateGasError,
} from '~/utils/tx-errors'
import { clearOperationMeta, setOperationMeta } from '~/utils/operationGuardRegistry'

const buildRevertError = (raw: Hex) =>
  new ContractFunctionRevertedError({
    abi: [],
    data: raw,
    functionName: 'test',
  })

const encodeSwapperSwapError = (innerRaw: Hex): Hex => {
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }],
    ['0x1111111111111111111111111111111111111111', innerRaw],
  )
  return `0x436fa211${args.slice(2)}` as Hex
}

const encodeErrorString = (reason: string): Hex => {
  const encoded = encodeAbiParameters([{ type: 'string' }], [reason])
  return `0x08c379a0${encoded.slice(2)}` as Hex
}

describe('tx-errors: Swapper_SwapError decoding', () => {
  it('decodes the Swapper_SwapError selector to its error name', () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(getTxErrorCode(err)).toBe('Swapper_SwapError')
  })

  it('returns a slippage-mentioning message for Swapper_SwapError', async () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(await getTxErrorMessage(err)).toMatch(/slippage/i)
  })

  it('hints to try a different swap provider for Swapper_SwapError', async () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(await getTxErrorMessage(err)).toMatch(/swap provider/i)
  })

  it('appends the inner Error(string) reason when present', async () => {
    const inner = encodeErrorString('Too little received')
    const err = buildRevertError(encodeSwapperSwapError(inner))
    expect(await getTxErrorMessage(err)).toMatch(/\(Too little received\)$/)
  })

  it('appends a known custom error name as the inner reason', async () => {
    // 0xea8e4eb5 = NotAuthorized (present in ERROR_SIGNATURE_MAP)
    const err = buildRevertError(encodeSwapperSwapError('0xea8e4eb5'))
    expect(await getTxErrorMessage(err)).toMatch(/\(NotAuthorized\)$/)
  })

  it('omits the inner reason suffix when inner bytes are unrecognised', async () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(await getTxErrorMessage(err)).not.toMatch(/\(.*\)$/)
  })
})

describe('shouldDiscardQuoteOnEstimateGasError', () => {
  it('discards quote estimation failures caused by Swapper_SwapError', () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(shouldDiscardQuoteOnEstimateGasError(err)).toBe(true)
  })

  it('discards quote estimation failures caused by SwapVerifier errors', () => {
    const err = buildRevertError('0x1c27d2c0')
    expect(shouldDiscardQuoteOnEstimateGasError(err)).toBe(true)
  })

  it('keeps quotes for other estimation failures', () => {
    const err = new Error('execution reverted: E_InsufficientCash')
    expect(shouldDiscardQuoteOnEstimateGasError(err)).toBe(false)
  })
})

describe('formatSimulationFailure: friendly message mapping', () => {
  const decodedEntry = (signature: string) => ({ signature, params: [] })

  it('maps an account status check E_AccountLiquidity to its friendly copy', () => {
    const result = {
      accountStatusErrors: [{
        account: '0x2222222222222222222222222222222222222222',
        decoded: [decodedEntry('E_AccountLiquidity()')],
      }],
    } as never
    expect(formatSimulationFailure(result)).toBe('Account liquidity too low for this action.')
  })

  it('maps a failed batch item E_AccountLiquidity to its friendly copy', () => {
    const result = {
      failedBatchItems: [{ index: 0, decodedError: [decodedEntry('E_AccountLiquidity()')] }],
    } as never
    expect(formatSimulationFailure(result)).toBe('Account liquidity too low for this action.')
  })

  it('maps Aave health-factor failures to Aave account health copy', () => {
    const result = {
      failedBatchItems: [{ index: 0, decodedError: [decodedEntry('HealthFactorLowerThanLiquidationThreshold()')] }],
    } as never
    expect(formatSimulationFailure(result)).toBe('Aave account health factor would be below the liquidation threshold.')
  })

  it('falls back to the decoded signature when the error name is unmapped', () => {
    const result = {
      accountStatusErrors: [{
        account: '0x2222222222222222222222222222222222222222',
        decoded: [decodedEntry('E_SomethingUnmapped()')],
      }],
    } as never
    expect(formatSimulationFailure(result)).toContain('E_SomethingUnmapped()')
  })

  it('blocks incomplete Account Lens snapshots with actionable copy', () => {
    const result = {
      snapshotReadFailures: [{
        layerIndex: 1,
        subAccount: '0x2222222222222222222222222222222222222222',
        vault: '0x3333333333333333333333333333333333333333',
        kind: 'vaultAccount',
        cause: 'inBand',
        reason: '0x1234',
      }],
    } as never

    expect(formatSimulationFailure(result)).toBe(
      'The complete account state could not be verified. Please try the simulation again.',
    )
  })
})

describe('isNonBlockingApprovalSimulationFailure', () => {
  const decodedEntry = (signature: string) => ({ signature, params: [] })
  const requiredApprovalPlan = [{
    type: 'requiredApproval',
    token: '0x1111111111111111111111111111111111111111',
    owner: '0x2222222222222222222222222222222222222222',
    spender: '0x3333333333333333333333333333333333333333',
    amount: 1n,
  }] as never
  const batchOnlyPlan = [{ type: 'evcBatch', items: [] }] as never

  it('does not block approval-like failed batch items when the plan has approvals', () => {
    const result = {
      failedBatchItems: [{
        index: 0,
        error: '0x',
        decodedError: [decodedEntry('E_TransferFromFailed()')],
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(requiredApprovalPlan, result)).toBe(true)
  })

  it('does not block approval-like simulation errors for prepared plans', () => {
    const prepared = {
      __prepared: true,
      plan: requiredApprovalPlan,
      chainId: 1,
      account: '0x2222222222222222222222222222222222222222',
      usePermit2: true,
      unlimitedApproval: false,
    } as never
    const result = {
      simulationError: {
        error: new Error('reverted'),
        decoded: [decodedEntry('ERC20InsufficientAllowance(address,address,uint256,uint256)')],
      },
    } as never

    expect(isNonBlockingApprovalSimulationFailure(prepared, result)).toBe(true)
  })

  it('requires approval or insufficiency context', () => {
    const result = {
      failedBatchItems: [{
        index: 0,
        error: '0x',
        decodedError: [decodedEntry('E_TransferFromFailed()')],
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(batchOnlyPlan, result)).toBe(false)
  })

  it('uses insufficiency diagnostics as context for approval-like failures', () => {
    const result = {
      failedBatchItems: [{
        index: 0,
        error: '0x',
        decodedError: [decodedEntry('SAFE_TRANSFER_FROM_FAILED()')],
      }],
      insufficientDirectAllowances: [{
        token: '0x1111111111111111111111111111111111111111',
        amount: 1n,
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(batchOnlyPlan, result)).toBe(true)
  })

  it('does not let derived account status failures block approval-like failed batch items', () => {
    const result = {
      failedBatchItems: [{
        index: 0,
        error: '0x9773bb71',
        decodedError: [
          decodedEntry('E_TransferFromFailed(bytes,bytes)'),
          decodedEntry('AllowanceExpired(uint256)'),
          decodedEntry('Expired()'),
          decodedEntry('ERC20InsufficientAllowance(address,uint256,uint256)'),
        ],
      }],
      accountStatusErrors: [{
        account: '0x2222222222222222222222222222222222222222',
        decoded: [decodedEntry('E_AccountLiquidity()')],
      }],
      insufficientPermit2Allowances: [{
        token: '0x1111111111111111111111111111111111111111',
        amount: 1n,
      }],
      insufficientDirectAllowances: [{
        token: '0x1111111111111111111111111111111111111111',
        amount: 1n,
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(requiredApprovalPlan, result)).toBe(true)
  })

  it('keeps account status failures blocking when there is no approval-like primary failure', () => {
    const result = {
      accountStatusErrors: [{
        account: '0x2222222222222222222222222222222222222222',
        decoded: [decodedEntry('E_AccountLiquidity()')],
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(requiredApprovalPlan, result)).toBe(false)
  })

  it('keeps non-approval protocol errors blocking', () => {
    const result = {
      failedBatchItems: [{
        index: 0,
        error: '0x',
        decodedError: [decodedEntry('E_AccountLiquidity()')],
      }],
    } as never

    expect(isNonBlockingApprovalSimulationFailure(requiredApprovalPlan, result)).toBe(false)
  })

  it('does not block thrown approval-like simulation errors when the plan has approvals', async () => {
    expect(
      await isNonBlockingApprovalSimulationError(
        requiredApprovalPlan,
        new Error('execution reverted: E_TransferFromFailed'),
      ),
    ).toBe(true)
  })

  it('requires approval context for thrown approval-like simulation errors', async () => {
    expect(
      await isNonBlockingApprovalSimulationError(
        batchOnlyPlan,
        new Error('execution reverted: E_TransferFromFailed'),
      ),
    ).toBe(false)
  })

  it('keeps thrown non-approval protocol errors blocking', async () => {
    expect(
      await isNonBlockingApprovalSimulationError(
        requiredApprovalPlan,
        new Error('execution reverted: E_AccountLiquidity'),
      ),
    ).toBe(false)
  })
})

describe('tx-errors: Keyring fee context', () => {
  afterEach(() => {
    clearOperationMeta('keyring')
  })

  it('uses operation metadata for Keyring credential fee balance errors', async () => {
    setOperationMeta('keyring', {
      credentialCost: 1_000_000_000_000_000,
      chainId: 1,
    })

    expect(await getTxErrorMessage(new Error('insufficient funds for gas * price + value'))).toContain('Keyring credential fee')
  })

  it('falls back to the generic balance error without Keyring metadata', async () => {
    expect(await getTxErrorMessage(new Error('insufficient funds for gas * price + value'))).toBe(
      'Insufficient balance to cover gas fees and transaction value.',
    )
  })
})

describe('tx-errors: Aave health-factor decoding', () => {
  it('decodes HealthFactorLowerThanLiquidationThreshold selector to a friendly message', async () => {
    const err = buildRevertError('0x6679996d')

    expect(getTxErrorCode(err)).toBe('HealthFactorLowerThanLiquidationThreshold')
    expect(await getTxErrorMessage(err)).toBe('Aave account health factor would be below the liquidation threshold.')
  })
})
