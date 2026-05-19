import { afterEach, describe, it, expect } from 'vitest'
import { ContractFunctionRevertedError, encodeAbiParameters, type Hex } from 'viem'
import { getTxErrorCode, getTxErrorMessage, shouldDiscardQuoteOnEstimateGasError } from '~/utils/tx-errors'
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
