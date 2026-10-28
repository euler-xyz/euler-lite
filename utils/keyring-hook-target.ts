import { getAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { keyringHookTargetAbi } from '~/abis/keyring'

export type KeyringHookGetterName = 'policyId' | 'getPolicyId' | 'keyring' | 'getKeyring'

export const readKeyringHookTargetValue = async <T>(
  client: PublicClient,
  hookTarget: Address,
  functionNames: readonly KeyringHookGetterName[],
): Promise<T> => {
  let lastError: unknown
  for (const functionName of functionNames) {
    try {
      return await client.readContract({
        address: hookTarget,
        abi: keyringHookTargetAbi,
        functionName,
        authorizationList: undefined,
      }) as T
    }
    catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error(`Keyring hook target ${hookTarget} has no compatible getter`)
}

export const validateKeyringContractAddress = async (
  client: PublicClient,
  address: Address,
): Promise<Address> => {
  const normalized = getAddress(address)
  if (normalized === zeroAddress) {
    throw new Error('Keyring credentials contract is the zero address')
  }

  const code = await client.getCode({ address: normalized })
  if (!code || code === '0x') {
    throw new Error(`Keyring credentials contract ${normalized} has no deployed code`)
  }

  return normalized
}

export const resolveKeyringContractAddress = async (
  client: PublicClient,
  hookTarget: Address,
): Promise<Address> => validateKeyringContractAddress(
  client,
  await readKeyringHookTargetValue<Address>(client, hookTarget, ['keyring', 'getKeyring']),
)
