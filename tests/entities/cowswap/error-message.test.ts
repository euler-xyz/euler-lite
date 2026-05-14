import { describe, expect, it } from 'vitest'
import { formatCowSwapExecutionErrorMessage } from '~/entities/cowswap/error-message'

describe('formatCowSwapExecutionErrorMessage', () => {
  it('removes verbose viem request and contract diagnostics from wallet rejections', () => {
    const error = new Error(
      'User rejected the request. Request Arguments: chain: Ethereum (id: 1) from: 0x9FA3c00a92Ec5f96B1Ad2527ab41B3932EFEDa58 to: 0xdACI7F958D2ee523a2206206994597C13D831ec7 data: 0x095ea7b3000000000000000000000000313603fa690301b0caaeef8069c065862f916216200000000000000000000000000000000000000000000000000000000000f4240 Contract Call: address: 0xdACI7F958D2ee523a2206206994597C13D831ec7 function: approve(address spender, uint256 amount) args: [0x313603FA690301b0CaaeEf8069c065862f9162162, 11000000] sender: 0x9FA3c00a92Ec5f96B1Ad2527ab41B3932EFEDa58 Docs: https://viem.sh/docs/contract/writeContract Details: User rejected the request. Version: viem@2.47.10',
    )

    expect(formatCowSwapExecutionErrorMessage(error)).toBe('User rejected the request.')
  })

  it('truncates unknown long messages', () => {
    const result = formatCowSwapExecutionErrorMessage(new Error('Unexpected wallet error '.repeat(20)))

    expect(result.length).toBeLessThanOrEqual(183)
    expect(result.endsWith('...')).toBe(true)
  })
})
