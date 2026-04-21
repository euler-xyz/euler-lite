import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep } from '~/utils/stepDecoding'
import type { Vault } from '~/entities/vault'
import type { SwapApiQuote } from '~/entities/swap'
import {
  COWSWAP_PROVIDER_NAME,
  COWSWAP_ORDER_DEADLINE_SECONDS,
  type CowSwapOpenPositionExecuteParams,
  deriveCowSwapBuyAmountFromQuote,
  getCowSwapChainConfig,
  isCowSwapSupportedChain,
} from '~/entities/cowswap'
import { useCowSwapOpenPositionExecution, useCowSwapOrderStatus, openCowSwapReviewModal } from '~/composables/cowswap'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { trimTrailingZeros } from '~/utils/string-utils'

interface UseMultiplyCowSwapOptions {
  multiplySelectedProvider: ComputedRef<string | null>
  multiplyEffectiveQuote: ComputedRef<SwapApiQuote | null>
  multiplySelectedQuote: ComputedRef<SwapApiQuote | null>
  multiplySupplyVault: ComputedRef<Vault | undefined>
  multiplyLongVault: ComputedRef<Vault | undefined>
  multiplyShortVault: ComputedRef<Vault | undefined>
  multiplySupplyProduct: ComputedRef<{ name: string }>
  multiplyShortProduct: ComputedRef<{ name: string }>
  multiplyInputAmount: Ref<string>
  multiplyShortAmount: ComputedRef<string>
  multiplyLongAmount: ComputedRef<string>
  multiplyDebtAmountNano: ComputedRef<bigint>
  multiplyErrorText: ComputedRef<string | null>
  resolvePendingSubAccount: () => Promise<string>
  refreshAllPositions: (lensAddresses: any, address: string) => void
  eulerLensAddresses: Ref<any>
}

export const useMultiplyCowSwap = (options: UseMultiplyCowSwapOptions) => {
  const { address } = useAccount()
  const router = useRouter()
  const modal = useModal()
  const { error } = useToast()
  const { client: rpcClient } = useRpcClient()
  const { chainId: currentChainId } = useEulerAddresses()

  const cowSwapExecution = useCowSwapOpenPositionExecution()
  const cowSwapOrderbookUrl = computed(() => getCowSwapChainConfig(currentChainId.value ?? 0)?.orderbookUrl)
  const cowSwapOrderStatus = useCowSwapOrderStatus(cowSwapExecution.orderUid, cowSwapOrderbookUrl)

  const isCowSwapProvider = computed(() =>
    options.multiplySelectedProvider.value?.toLowerCase() === COWSWAP_PROVIDER_NAME
    || (!options.multiplySelectedProvider.value && options.multiplyEffectiveQuote.value?.route?.some(r => r.providerName?.toLowerCase() === COWSWAP_PROVIDER_NAME)),
  )

  const cowSwapStatusLabel = computed(() => {
    if (!isCowSwapProvider.value || cowSwapExecution.status.value === 'idle') return null
    switch (cowSwapExecution.status.value) {
      case 'approving_collateral': return 'Approving collateral...'
      case 'signing_permit': return 'Sign EVC permit in wallet...'
      case 'signing_order': return 'Sign CoW order in wallet...'
      case 'submitting': return 'Submitting order...'
      case 'submitted': {
        const orderType = cowSwapOrderStatus.orderStatus.value?.type
        return orderType && orderType !== 'unknown'
          ? `Order ${orderType}`
          : 'Order submitted, waiting for fill...'
      }
      default: return null
    }
  })

  // Watch for CowSwap order completion
  watch(() => cowSwapOrderStatus.orderStatus.value, (orderStatusVal) => {
    if (!orderStatusVal?.terminal) return
    if (orderStatusVal.type === 'traded' || orderStatusVal.type === 'fulfilled') {
      options.refreshAllPositions(options.eulerLensAddresses.value, address.value || '')
      modal.close()
      setTimeout(() => {
        router.replace('/portfolio')
        cowSwapExecution.reset()
      }, 400)
    }
    else {
      // Don't reset — leave terminal status visible in modal until user dismisses
    }
  })

  const submitCowSwapMultiply = async () => {
    cowSwapExecution.reset()
    const supplyVault = options.multiplySupplyVault.value
    const longVault = options.multiplyLongVault.value
    const shortVault = options.multiplyShortVault.value
    if (!supplyVault || !longVault || !shortVault) return
    if (!options.multiplyInputAmount.value || options.multiplyDebtAmountNano.value <= 0n) return
    if (options.multiplyErrorText.value) return

    const quote = options.multiplySelectedQuote.value
    if (!quote) return

    const chainId = currentChainId.value ?? 0
    if (!isCowSwapSupportedChain(chainId)) return

    let subAccount: string
    try {
      subAccount = await options.resolvePendingSubAccount()
    }
    catch (e) {
      logWarn('multiply/cowswap/resolveSubaccount', e)
      error('Unable to resolve position')
      return
    }

    const supplyAmountNano = valueToNano(options.multiplyInputAmount.value || '0', supplyVault.asset.decimals)
    const debtAmount = options.multiplyDebtAmountNano.value
    const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS

    const underlyingBuyAmount = deriveCowSwapBuyAmountFromQuote({
      amountOutMin: quote.amountOutMin,
      amountOut: quote.amountOut,
    })
    if (!underlyingBuyAmount || underlyingBuyAmount <= 0n) {
      error('Invalid quote: no minimum buy amount')
      return
    }
    const { totalAssets, totalShares } = longVault
    const buyAmount = totalAssets > 0n
      ? underlyingBuyAmount * totalShares / totalAssets
      : underlyingBuyAmount

    const cowParams: CowSwapOpenPositionExecuteParams = {
      chainId,
      sellToken: shortVault.asset.address as Address,
      buyToken: longVault.address as Address,
      sellAmount: debtAmount,
      buyAmount,
      validTo,
      collateralToken: supplyVault.asset.address as Address,
      wrapper: {
        owner: address.value as Address,
        account: subAccount as Address,
        deadline: validTo,
        collateralVault: supplyVault.address as Address,
        borrowVault: shortVault.address as Address,
        collateralAmount: supplyAmountNano,
        borrowAmount: debtAmount,
      },
    }

    let needsCollateralApproval = true
    let needsSellTokenApproval = true
    try {
      const client = rpcClient.value
      if (client) {
        const chainConfig = getCowSwapChainConfig(chainId)
        const collateralAllowance = await client.readContract({
          address: supplyVault.asset.address as Address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address.value as Address, supplyVault.address as Address],
        }) as bigint
        needsCollateralApproval = collateralAllowance < supplyAmountNano

        if (chainConfig) {
          const sellTokenAllowance = await client.readContract({
            address: shortVault.asset.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address.value as Address, chainConfig.vaultRelayer],
          }) as bigint
          needsSellTokenApproval = sellTokenAllowance < debtAmount
        }
      }
    }
    catch {
      // Default to showing approval steps
    }

    const collateralAsset = supplyVault.asset
    const borrowAsset = shortVault.asset
    const borrowAmountStr = options.multiplyShortAmount.value || formatUnits(debtAmount, Number(borrowAsset.decimals))
    const swapOutMinAmount = quote.amountOutMin
      ? trimTrailingZeros(formatUnits(BigInt(quote.amountOutMin), Number(longVault.asset.decimals)))
      : options.multiplyLongAmount.value

    const signSteps: DisplayStep[] = []
    let idx = 1
    if (needsCollateralApproval) {
      signSteps.push({ index: idx++, label: 'Approve for deposit', isSeparateTx: true, assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: options.multiplyInputAmount.value } })
    }
    if (needsSellTokenApproval) {
      signSteps.push({ index: idx++, label: 'Approve for swap', isSeparateTx: true, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: borrowAmountStr } })
    }
    signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
    signSteps.push({ index: idx++, label: 'Sign CoW order', isSeparateTx: false })

    const collateralVaultName = options.multiplySupplyProduct.value.name || collateralAsset.symbol
    const borrowVaultName = options.multiplyShortProduct.value.name || borrowAsset.symbol
    let wIdx = 1
    const wrapperSteps: DisplayStep[] = [
      { index: wIdx++, label: 'Enable collateral', labelSuffix: collateralVaultName, isSeparateTx: false },
      { index: wIdx++, label: 'Enable controller', labelSuffix: borrowVaultName, isSeparateTx: false },
      { index: wIdx++, label: 'Supply', isSeparateTx: false, assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: options.multiplyInputAmount.value } },
      { index: wIdx++, label: 'Borrow', isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: borrowAmountStr } },
      { index: wIdx++, label: 'Swap', isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: borrowAmountStr }, toAssetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: options.multiplyLongAmount.value } },
      { index: wIdx++, label: 'Verify min received', isSeparateTx: false, assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: swapOutMinAmount } },
    ]

    const walletWarningsDescription
      = `The CoW order is signed with buy amounts in ${supplyVault.symbol} shares. `
        + `The amounts shown above are in ${collateralAsset.symbol} (underlying). `
        + 'The CoW order receiver is your sub-account, not your main wallet — your wallet may flag this as a mismatch. '
        + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

    openCowSwapReviewModal(modal, {
      signSteps,
      wrapperSteps,
      walletWarningsDescription,
      execution: cowSwapExecution,
      orderStatus: cowSwapOrderStatus,
      executeParams: cowParams,
      logPrefix: 'multiply/cowswap',
    })
  }

  return {
    isCowSwapProvider,
    cowSwapExecution,
    cowSwapOrderStatus,
    cowSwapStatusLabel,
    submitCowSwapMultiply,
  }
}
