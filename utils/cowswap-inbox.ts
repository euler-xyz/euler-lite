import type { Address, PublicClient } from 'viem'
import { logWarn } from '~/utils/errorHandling'

/**
 * Minimal ABI fragment for the CoW close-position wrapper. The full ABI lives
 * inside the SDK, but we only need this one view function here to decide
 * whether the user has already deployed their inbox account — if so, we can
 * skip the "Prepare order receiver" sign step from the visible step list.
 * (The SDK still no-ops the prep at execution time when the inbox exists.)
 */
const INBOX_LOOKUP_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'subaccount', type: 'address' },
    ],
    name: 'getInboxAddressAndDomainSeparator',
    outputs: [
      { name: '', type: 'address' },
      { name: '', type: 'bytes32' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Returns true when the user's CoW inbox account for the given (wrapper, owner,
 * subaccount) already has code on chain. Logs and returns false on any RPC
 * error — the worst case is we show the prep step that turns out to be a no-op,
 * which is correct fail-closed behavior for honest step counts.
 */
export const cowSwapInboxExists = async (params: {
  client: PublicClient
  wrapperAddress: Address
  owner: Address
  subaccount: Address
}): Promise<boolean> => {
  try {
    const [inboxAddress] = (await params.client.readContract({
      address: params.wrapperAddress,
      abi: INBOX_LOOKUP_ABI,
      functionName: 'getInboxAddressAndDomainSeparator',
      authorizationList: undefined,
      args: [params.owner, params.subaccount],
    })) as [Address, `0x${string}`]
    const inboxCode = await params.client.getCode({ address: inboxAddress })
    return !!inboxCode && inboxCode !== '0x'
  }
  catch (err) {
    logWarn('cowswap/inboxExists', err)
    return false
  }
}
