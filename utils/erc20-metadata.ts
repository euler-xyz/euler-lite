import { hexToString, type Address, type Hex, type PublicClient } from 'viem'
import {
  erc20NameAbi,
  erc20NameBytes32Abi,
  erc20SymbolAbi,
  erc20SymbolBytes32Abi,
} from '~/abis/erc20'

// Legacy tokens such as MKR return bytes32 from name()/symbol() instead of the
// ERC-20-standard string. hexToString keeps the right-NUL padding of a fixed
// bytes32, so cut at the first NUL byte — e.g. MKR's name decodes to "Maker".
export function bytes32ToString(value: Hex): string {
  return hexToString(value).split(String.fromCharCode(0))[0]
}

// Reads an ERC-20 name/symbol, tolerating tokens that return bytes32 rather than
// string (e.g. MKR). Tries the string ABI first, then the bytes32 variant, and
// returns null when neither yields a non-empty value.
export async function readErc20StringField(
  client: PublicClient,
  address: Address,
  field: 'name' | 'symbol',
): Promise<string | null> {
  try {
    const value = field === 'name'
      ? await client.readContract({ address, abi: erc20NameAbi, functionName: 'name', authorizationList: undefined })
      : await client.readContract({ address, abi: erc20SymbolAbi, functionName: 'symbol', authorizationList: undefined })
    if (typeof value === 'string' && value.length > 0) return value
  }
  catch {
    // Standard string decode failed — fall through to the bytes32 variant.
  }

  try {
    const value = field === 'name'
      ? await client.readContract({ address, abi: erc20NameBytes32Abi, functionName: 'name', authorizationList: undefined })
      : await client.readContract({ address, abi: erc20SymbolBytes32Abi, functionName: 'symbol', authorizationList: undefined })
    if (typeof value === 'string' && value.startsWith('0x')) {
      const decoded = bytes32ToString(value as Hex)
      if (decoded.length > 0) return decoded
    }
  }
  catch {
    // Not decodable as bytes32 either — give up.
  }

  return null
}
