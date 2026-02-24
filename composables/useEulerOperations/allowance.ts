import type { Address, Hex, StateOverride } from 'viem'
import { encodePacked, getAddress, hexToBigInt, keccak256, maxUint256, toHex } from 'viem'
import { readContract } from '@wagmi/vue/actions'
import type { OperationsContext, Permit2Helpers, AllowanceHelpers } from './types'
import { ALLOWANCE_MAX_SEQUENTIAL_SLOT, ALLOWANCE_EXTRA_SLOT_CANDIDATES } from '~/entities/constants'
import { erc20ABI } from '~/entities/euler/abis'
import type { EVCCall } from '~/utils/evc-converter'
import type { TxPlan } from '~/entities/txPlan'
import { logWarn } from '~/utils/errorHandling'

const allowanceSlotIndexCache = new Map<string, bigint>()
const maxUint256Hex = toHex(maxUint256, { size: 32 })

export const createAllowanceHelpers = (ctx: OperationsContext, permit2: Permit2Helpers): AllowanceHelpers => {
  const checkAllowance = async (assetAddress: Address, spenderAddress: Address, userAddress: Address): Promise<bigint> => {
    try {
      const allowance = await ctx.rpcProvider.readContract({
        address: assetAddress,
        abi: erc20ABI,
        functionName: 'allowance',
        args: [userAddress, spenderAddress],
      })
      return allowance as bigint
    }
    catch (e) {
      console.error('Error checking allowance:', e)
      return 0n
    }
  }

  const normalizeAddress = (address: Address | string) => {
    try {
      return getAddress(address)
    }
    catch {
      return address.toLowerCase()
    }
  }

  const computeErc20AllowanceSlot = (owner: Address, spender: Address, slotIndex: bigint): Hex => {
    const baseSlot = keccak256(encodePacked(['uint256', 'uint256'], [hexToBigInt(owner), slotIndex]))
    return keccak256(encodePacked(['uint256', 'uint256'], [hexToBigInt(spender), hexToBigInt(baseSlot)]))
  }

  const resolveAllowanceSlotIndex = async (token: Address, owner: Address, spender: Address): Promise<bigint | undefined> => {
    const tokenKey = normalizeAddress(token)
    const cached = allowanceSlotIndexCache.get(tokenKey)
    if (cached !== undefined) {
      return cached
    }

    const trySlot = async (slotIndex: bigint): Promise<boolean> => {
      const slot = computeErc20AllowanceSlot(owner, spender, slotIndex)
      try {
        const value = await readContract(ctx.config, {
          address: token,
          abi: erc20ABI,
          functionName: 'allowance',
          args: [owner, spender],
          stateOverride: [
            {
              address: token,
              stateDiff: [{ slot, value: maxUint256Hex }],
            },
          ],
        })
        if (value === maxUint256) {
          allowanceSlotIndexCache.set(tokenKey, slotIndex)
          return true
        }
      }
      catch {
        // slot candidate didn't match
      }
      return false
    }

    for (let i = 0; i <= ALLOWANCE_MAX_SEQUENTIAL_SLOT; i++) {
      if (await trySlot(BigInt(i))) return BigInt(i)
    }
    for (const slotIndex of ALLOWANCE_EXTRA_SLOT_CANDIDATES) {
      if (await trySlot(slotIndex)) return slotIndex
    }

    logWarn('resolveAllowanceSlotIndex', 'no slot found for token', { data: { token: tokenKey, owner, spender } })
    return undefined
  }

  const buildErc20AllowanceOverrides = async (
    pairs: { token: Address, spender: Address }[],
    owner: Address,
  ): Promise<StateOverride> => {
    const overridesByToken = new Map<string, { address: Address, stateDiff: { slot: Hex, value: Hex }[] }>()
    for (const pair of pairs) {
      let slotIndex: bigint | undefined
      try {
        slotIndex = await resolveAllowanceSlotIndex(pair.token, owner, pair.spender)
      }
      catch {
        slotIndex = undefined
      }
      if (slotIndex === undefined) {
        continue
      }
      const slot = computeErc20AllowanceSlot(owner, pair.spender, slotIndex)
      const tokenKey = normalizeAddress(pair.token)
      const entry = overridesByToken.get(tokenKey) || { address: pair.token, stateDiff: [] }
      if (!entry.stateDiff.some(diff => diff.slot === slot)) {
        entry.stateDiff.push({ slot, value: maxUint256Hex })
      }
      overridesByToken.set(tokenKey, entry)
    }
    return Array.from(overridesByToken.values())
  }

  // Selector for SwapVerifier.transferFromSender(address token, uint256 amount, address receiver)
  const TRANSFER_FROM_SENDER_SELECTOR = '0xbe6f2b2f'

  const extractTokenFromTransferFromSender = (data: string): Address | undefined => {
    if (!data.startsWith(TRANSFER_FROM_SENDER_SELECTOR) || data.length < 74) {
      return undefined
    }
    try {
      return getAddress(`0x${data.slice(34, 74)}`) as Address
    }
    catch {
      return undefined
    }
  }

  const buildSimulationStateOverride = async (plan: TxPlan, owner: Address): Promise<StateOverride> => {
    const approvalPairs: { token: Address, spender: Address }[] = []
    const approvalSeen = new Set<string>()
    const permit2TokenAddresses: Address[] = []

    for (const step of plan.steps) {
      if (step.type === 'permit2-approve') {
        permit2TokenAddresses.push(step.to)
      }
      if (step.type !== 'approve' && step.type !== 'permit2-approve') {
        continue
      }
      const spender = step.args?.[0]
      if (typeof spender !== 'string') {
        continue
      }
      const token = step.to as Address
      const key = `${normalizeAddress(token)}:${normalizeAddress(spender as Address)}`
      if (!approvalSeen.has(key)) {
        approvalSeen.add(key)
        approvalPairs.push({ token, spender: spender as Address })
      }
    }

    // Always build Permit2 overrides — they're harmless when Permit2 isn't used
    // and essential when Permit2 IS used (even without a separate permit2-approve step,
    // e.g. when the user already approved the token for Permit2 in a previous tx).
    const permit2Pairs = new Map<string, { address: Address, pairs: { token: Address, spender: Address }[] }>()
    const permit2Address = permit2.resolvePermit2Address()
    if (permit2Address) {
      // Collect tokens from permit2-approve steps AND from transferFromSender calldata in the batch
      const knownTokens = new Set<string>(permit2TokenAddresses.map(normalizeAddress))
      for (const step of plan.steps) {
        if (step.type !== 'evc-batch') continue
        const calls = step.args?.[0] as EVCCall[] | undefined
        if (!Array.isArray(calls)) continue
        for (const call of calls) {
          const token = extractTokenFromTransferFromSender(call?.data)
          if (token) {
            knownTokens.add(normalizeAddress(token))
          }
        }
      }
      const tokenAddresses = [...knownTokens].map(t => getAddress(t) as Address)

      // Ensure ERC20 allowance overrides exist for token → Permit2.
      // When the plan omits the permit2-approve step (e.g. user already approved
      // in a previous session), the approval pairs list is empty and the simulation
      // would fail because Permit2 can't pull the token from the user.
      for (const token of tokenAddresses) {
        const key = `${normalizeAddress(token)}:${normalizeAddress(permit2Address)}`
        if (!approvalSeen.has(key)) {
          approvalSeen.add(key)
          approvalPairs.push({ token, spender: permit2Address })
        }
      }

      for (const step of plan.steps) {
        if (step.type !== 'evc-batch') continue
        const calls = step.args?.[0] as EVCCall[] | undefined
        if (!Array.isArray(calls)) continue

        const permit2Key = normalizeAddress(permit2Address)
        const entry = permit2Pairs.get(permit2Key) || { address: permit2Address, pairs: [] }

        const addPair = (token: Address, spender: Address) => {
          const pairKey = `${normalizeAddress(token)}:${normalizeAddress(spender)}`
          if (!entry.pairs.some(pair => `${normalizeAddress(pair.token)}:${normalizeAddress(pair.spender)}` === pairKey)) {
            entry.pairs.push({ token, spender })
          }
        }

        for (const call of calls) {
          const target = call?.targetContract
          if (!target) continue

          // Vault target: vault pulls tokens via Permit2.transferFrom
          const vaultEntry = ctx.registryGet(normalizeAddress(target))
          const vault = vaultEntry?.vault
          if (vault?.asset?.address && vault.address) {
            addPair(vault.asset.address as Address, vault.address as Address)
            continue
          }

          // Non-vault target: only override if this call uses transferFromSender
          // (e.g. SwapVerifier pulls tokens via Permit2)
          const transferToken = extractTokenFromTransferFromSender(call?.data)
          if (transferToken) {
            addPair(transferToken, target)
          }
        }

        permit2Pairs.set(permit2Key, entry)
      }
    }

    const erc20Overrides = await buildErc20AllowanceOverrides(approvalPairs, owner)
    const permit2Overrides = permit2.buildPermit2Overrides(permit2Pairs, owner)

    return [...permit2Overrides, ...erc20Overrides]
  }

  return {
    checkAllowance,
    normalizeAddress,
    computeErc20AllowanceSlot,
    resolveAllowanceSlotIndex,
    buildErc20AllowanceOverrides,
    extractTokenFromTransferFromSender,
    buildSimulationStateOverride,
  }
}
