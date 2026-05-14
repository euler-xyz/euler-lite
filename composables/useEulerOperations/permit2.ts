import type { Address, Hex } from 'viem'
import { encodeFunctionData, encodePacked, hexToBigInt, keccak256, toHex, maxUint256, zeroAddress } from 'viem'
import type { OperationsContext, Permit2Helpers } from './types'
import { MAX_UINT160, PERMIT2_TYPES, permit2Abi } from '~/entities/permit2'
import { PERMIT2_SIG_WINDOW } from '~/entities/constants'
import type { EVCCall } from '~/utils/evc-converter'
import { assertOperationNotBlocked } from '~/utils/operationGuardRegistry'

const maxUint256Hex = toHex(maxUint256, { size: 32 })
const nowInSeconds = () => BigInt(Math.floor(Date.now() / 1000))

export const createPermit2Helpers = (ctx: OperationsContext): Permit2Helpers => {
  const resolvePermit2Address = (): Address | undefined => {
    const permit2 = ctx.eulerCoreAddresses.value?.permit2 as Address | undefined
    return permit2 && permit2 !== zeroAddress ? permit2 : undefined
  }

  const getPermit2Allowance = async (token: Address, spender: Address, owner: Address, permit2Address?: Address) => {
    const resolvedPermit2 = permit2Address ?? resolvePermit2Address()
    if (!resolvedPermit2) {
      return { amount: 0n, expiration: 0n, nonce: 0n }
    }

    try {
      const result = await ctx.rpcProvider.readContract({
        address: resolvedPermit2,
        abi: permit2Abi,
        functionName: 'allowance',
        args: [owner, token, spender],
      })
      const tuple = result as unknown as readonly [bigint, bigint, bigint]
      return {
        amount: tuple[0] ?? 0n,
        expiration: tuple[1] ?? 0n,
        nonce: tuple[2] ?? 0n,
      }
    }
    catch {
      return { amount: 0n, expiration: 0n, nonce: 0n }
    }
  }

  const buildPermit2Call = async (token: Address, spender: Address, requiredAmount: bigint, owner: Address, permit2Address?: Address): Promise<EVCCall | undefined> => {
    const resolvedPermit2 = permit2Address ?? resolvePermit2Address()
    if (!ctx.chainId.value || !resolvedPermit2) {
      return undefined
    }

    const allowance = await getPermit2Allowance(token, spender, owner, resolvedPermit2)
    const currentTime = nowInSeconds()

    if (allowance.amount >= requiredAmount && allowance.expiration > currentTime) {
      return undefined
    }

    const permitSingle = {
      details: {
        token,
        amount: requiredAmount > MAX_UINT160 ? MAX_UINT160 : requiredAmount,
        expiration: Number(currentTime + PERMIT2_SIG_WINDOW),
        nonce: Number(allowance.nonce),
      },
      spender,
      sigDeadline: currentTime + PERMIT2_SIG_WINDOW,
    }

    assertOperationNotBlocked()
    const signature = await ctx.signTypedDataAsync({
      domain: {
        name: 'Permit2',
        chainId: ctx.chainId.value,
        verifyingContract: resolvedPermit2,
      },
      types: PERMIT2_TYPES,
      primaryType: 'PermitSingle',
      message: permitSingle,
    })

    const data = encodeFunctionData({
      abi: permit2Abi,
      functionName: 'permit',
      args: [owner, permitSingle, signature],
    })

    return {
      targetContract: resolvedPermit2,
      onBehalfOfAccount: owner,
      value: 0n,
      data,
    }
  }

  const computePermit2AllowanceSlot = (owner: Address, token: Address, spender: Address): Hex => {
    const baseSlot = keccak256(encodePacked(['uint256', 'uint256'], [hexToBigInt(owner), 1n]))
    const assetSlot = keccak256(encodePacked(['uint256', 'uint256'], [hexToBigInt(token), hexToBigInt(baseSlot)]))
    return keccak256(encodePacked(['uint256', 'uint256'], [hexToBigInt(spender), hexToBigInt(assetSlot)]))
  }

  const buildPermit2Overrides = (
    pairsByPermit2: Map<string, { address: Address, pairs: { token: Address, spender: Address }[] }>,
    owner: Address,
  ): import('viem').StateOverride => {
    const overrides: import('viem').StateOverride = []
    for (const entry of pairsByPermit2.values()) {
      const stateDiff = entry.pairs.map(pair => ({
        slot: computePermit2AllowanceSlot(owner, pair.token, pair.spender),
        value: maxUint256Hex,
      }))
      if (stateDiff.length) {
        overrides.push({
          address: entry.address,
          stateDiff,
        })
      }
    }
    return overrides
  }

  return {
    resolvePermit2Address,
    getPermit2Allowance,
    buildPermit2Call,
    computePermit2AllowanceSlot,
    buildPermit2Overrides,
  }
}
