import {
  concat,
  encodeAbiParameters,
  keccak256,
  toHex,
  getAddress,
  type Address,
  type Hex,
} from 'viem'

export const INBOX_DOMAIN_NAME = 'Inbox'
export const INBOX_DOMAIN_VERSION = '1'

/** Pre-computed keccak256 hashes for CoW order string fields */
const KIND_SELL = keccak256(toHex('sell'))
const KIND_BUY = keccak256(toHex('buy'))
const BALANCE_ERC20 = keccak256(toHex('erc20'))

/**
 * ABI types for the CoW order struct with bytes32 fields
 * (string fields pre-hashed per EIP-712 encodeData spec).
 * 12 fields × 32 bytes = 384 bytes.
 */
const ORDER_ENCODE_DATA_ABI = [
  { type: 'address' }, // sellToken
  { type: 'address' }, // buyToken
  { type: 'address' }, // receiver
  { type: 'uint256' }, // sellAmount
  { type: 'uint256' }, // buyAmount
  { type: 'uint32' }, // validTo
  { type: 'bytes32' }, // appData
  { type: 'uint256' }, // feeAmount
  { type: 'bytes32' }, // kind (keccak256-hashed)
  { type: 'bool' }, // partiallyFillable
  { type: 'bytes32' }, // sellTokenBalance (keccak256-hashed)
  { type: 'bytes32' }, // buyTokenBalance (keccak256-hashed)
] as const

/**
 * Encode the CoW order struct for Inbox EIP-1271 signature verification.
 * The Inbox expects 384 bytes of ABI-encoded order data where string fields
 * (kind, sellTokenBalance, buyTokenBalance) are keccak256-hashed to bytes32.
 */
export const encodeOrderDataForInbox = (order: {
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  appData: Hex
  feeAmount: bigint
  kind: 'sell' | 'buy'
  partiallyFillable: boolean
  sellTokenBalance: string
  buyTokenBalance: string
}): Hex => encodeAbiParameters(ORDER_ENCODE_DATA_ABI, [
  order.sellToken,
  order.buyToken,
  order.receiver,
  order.sellAmount,
  order.buyAmount,
  order.validTo,
  order.appData,
  order.feeAmount,
  order.kind === 'sell' ? KIND_SELL : KIND_BUY,
  order.partiallyFillable,
  BALANCE_ERC20,
  BALANCE_ERC20,
])

/**
 * Build the EIP-1271 signature for Inbox verification.
 * Format: concat(ecdsaSignature[65 bytes], orderEncodeData[384 bytes])
 */
export const buildInboxSignature = (
  ecdsaSignature: Hex,
  orderEncodeData: Hex,
): Hex => concat([ecdsaSignature, orderEncodeData])

/**
 * Verify that the EIP-712 domain separator computed from the Inbox address
 * matches the one returned by the wrapper contract.
 */
export const verifyInboxDomainSeparator = (
  inboxAddress: Address,
  chainId: number,
  expectedDomainSep: Hex,
): void => {
  const domainTypeHash = keccak256(
    toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
  )
  const nameHash = keccak256(toHex(INBOX_DOMAIN_NAME))
  const versionHash = keccak256(toHex(INBOX_DOMAIN_VERSION))

  const computed = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [domainTypeHash, nameHash, versionHash, BigInt(chainId), getAddress(inboxAddress)],
  ))

  if (computed !== expectedDomainSep) {
    throw new Error(
      `Inbox domain separator mismatch: computed ${computed}, expected ${expectedDomainSep}`,
    )
  }
}
