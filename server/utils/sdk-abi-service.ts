import type { IABIService } from '@eulerxyz/euler-v2-sdk'
import type { Abi } from 'viem'
import { ABI_CONTRACTS, loadAbi } from '~/server/api/internal/abis/[contract].get'

/** Server SDK reads share the browser proxy's sources, validation and cache. */
export const serverAbiService: IABIService = {
  async fetchABI(_chainId, contract) {
    const allowedContract = ABI_CONTRACTS.find(name => name === contract)
    if (!allowedContract) throw new Error('Unknown ABI contract')
    return await loadAbi(allowedContract) as Abi
  },
}
