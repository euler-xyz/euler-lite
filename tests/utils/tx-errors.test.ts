import { describe, it, expect } from 'vitest'
import { ContractFunctionRevertedError, encodeAbiParameters, type Hex } from 'viem'
import { getTxErrorCode, getTxErrorMessage } from '~/utils/tx-errors'

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

  it('returns a slippage-mentioning message for Swapper_SwapError', () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(getTxErrorMessage(err)).toMatch(/slippage/i)
  })

  it('hints to try a different swap provider for Swapper_SwapError', () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(getTxErrorMessage(err)).toMatch(/swap provider/i)
  })

  it('appends the inner Error(string) reason when present', () => {
    const inner = encodeErrorString('Too little received')
    const err = buildRevertError(encodeSwapperSwapError(inner))
    expect(getTxErrorMessage(err)).toMatch(/\(Too little received\)$/)
  })

  it('appends a known custom error name as the inner reason', () => {
    // 0xea8e4eb5 = NotAuthorized (present in ERROR_SIGNATURE_MAP)
    const err = buildRevertError(encodeSwapperSwapError('0xea8e4eb5'))
    expect(getTxErrorMessage(err)).toMatch(/\(NotAuthorized\)$/)
  })

  it('omits the inner reason suffix when inner bytes are unrecognised', () => {
    const err = buildRevertError(encodeSwapperSwapError('0xdeadbeef'))
    expect(getTxErrorMessage(err)).not.toMatch(/\(.*\)$/)
  })
})
