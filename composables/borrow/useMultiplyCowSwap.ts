import type { Ref, ComputedRef } from 'vue'
import { useAccount } from '@wagmi/vue'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep } from '~/utils/stepDecoding'
import type { Vault } from '~/entities/vault'
import type { SwapApiQuote } from '~/entities/swap'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  type CowSwapOpenPositionExecuteParams,
  getCowSwapQuoteOrderAmounts,
  getCowSwapChainConfig,
  isCowProvider,
  isCowSwapSupportedChain,
} from '~/entities/cowswap'
import { useCowSwapOpenPositionExecution, useCowSwapOrderStatus, openCowSwapReviewModal, buildApprovalSignSteps } from '~/composables/cowswap'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { trimTrailingZeros } from '~/utils/string-utils'
import { getNewSubAccount } from '~/entities/account'
import type { EulerLensAddresses } from '~/composables/useEulerAddresses'

const convertVaultSharesToAssets = (vault: Vault, sharesAmount: bigint): bigint => {
  if (sharesAmount <= 0n) return 0n
  if (vault.totalShares <= 0n) return sharesAmount
  return (sharesAmount * vault.totalAssets) / vault.totalShares
}

interface UseMultiplyCowSwapOptions {
  multiplySelectedProvider: ComputedRef<string | null>
  multiplyEffectiveProvider: ComputedRef<string | null>
  multiplyEffectiveQuote: ComputedRef<SwapApiQuote | null>
  multiplySelectedQuote: ComputedRef<SwapApiQuote | null>
  multiplyEffectiveQuoteFetchedAt: ComputedRef<number | null>
  multiplySlippage: Readonly<Ref<number>>
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
  refreshAllPositions: (lensAddresses: EulerLensAddresses, address: string) => void | Promise<void>
  eulerLensAddresses: Ref<EulerLensAddresses>
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
    isCowProvider(options.multiplySelectedProvider.value)
    || (!options.multiplySelectedProvider.value && isCowProvider(options.multiplyEffectiveProvider.value)),
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

    if (!address.value) return
    let subAccount: string
    try {
      subAccount = await getNewSubAccount(address.value, shortVault.address)
      if (
        quote.accountIn.toLowerCase() !== subAccount.toLowerCase()
        || quote.accountOut.toLowerCase() !== subAccount.toLowerCase()
      ) {
        logWarn('multiply/cowswap/subaccountMismatch', 'Selected CoW quote uses a different sub-account', {
          data: {
            quoteAccountIn: quote.accountIn,
            quoteAccountOut: quote.accountOut,
            executionSubAccount: subAccount,
          },
        })
        error('Quote is stale. Refresh quote and try again.')
        return
      }
    }
    catch (e) {
      logWarn('multiply/cowswap/resolveSubaccount', e)
      error('Unable to resolve position')
      return
    }

    const supplyAmountNano = valueToNano(options.multiplyInputAmount.value || '0', supplyVault.asset.decimals)
    const validTo = quote.providerData?.appDataDeadline ?? Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS
    const expectedSellAmount = options.multiplyDebtAmountNano.value

    if (!quote.providerData?.appData) {
      error('Invalid quote: missing CoW appData')
      return
    }

    const orderAmounts = getCowSwapQuoteOrderAmounts(quote, {
      slippage: options.multiplySlippage.value,
      slippageTarget: 'buyAmount',
    })
    if (!orderAmounts) {
      error('Invalid quote: missing CoW order amounts')
      return
    }
    const { sellAmount, buyAmount } = orderAmounts
    const rawOrderAmounts = getCowSwapQuoteOrderAmounts(quote)
    if (!rawOrderAmounts) {
      error('Invalid quote: missing CoW order amounts')
      return
    }
    if (sellAmount !== expectedSellAmount) {
      error('Quote is stale. Refresh quote and try again.')
      return
    }
    if (convertVaultSharesToAssets(longVault, rawOrderAmounts.buyAmount) !== BigInt(quote.amountOut || 0)) {
      error('Quote is stale. Refresh quote and try again.')
      return
    }

    const cowParams: CowSwapOpenPositionExecuteParams = {
      chainId,
      quote,
      expectedSellAmount,
      expectedAppData: quote.providerData.appData,
      sellToken: shortVault.asset.address as Address,
      buyToken: longVault.address as Address,
      sellAmount,
      buyAmount,
      quoteId: quote.providerData?.quoteId,
      slippage: options.multiplySlippage.value,
      slippageBips: Math.round(options.multiplySlippage.value * 100),
      validTo,
      collateralToken: supplyVault.asset.address as Address,
      wrapper: {
        owner: address.value as Address,
        account: subAccount as Address,
        deadline: validTo,
        collateralVault: supplyVault.address as Address,
        borrowVault: shortVault.address as Address,
        collateralAmount: supplyAmountNano,
        borrowAmount: expectedSellAmount,
      },
    }

    let collateralAllowance = 0n
    let sellTokenAllowance = 0n
    try {
      const client = rpcClient.value
      if (client) {
        const chainConfig = getCowSwapChainConfig(chainId)
        collateralAllowance = await client.readContract({
          address: supplyVault.asset.address as Address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address.value as Address, supplyVault.address as Address],
        }) as bigint

        if (chainConfig) {
          sellTokenAllowance = await client.readContract({
            address: shortVault.asset.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address.value as Address, chainConfig.vaultRelayer],
          }) as bigint
        }
      }
    }
    catch {
      // Default to showing approval steps
    }

    const collateralAsset = supplyVault.asset
    const borrowAsset = shortVault.asset
    const borrowAmountStr = trimTrailingZeros(formatUnits(sellAmount, Number(borrowAsset.decimals)))
    const swapOutMinAmount = trimTrailingZeros(
      formatUnits(convertVaultSharesToAssets(longVault, buyAmount), Number(longVault.asset.decimals)),
    )

    const signSteps: DisplayStep[] = []
    let idx = 1
    const collateralApproval = buildApprovalSignSteps({
      tokenAddress: supplyVault.asset.address,
      currentAllowance: collateralAllowance,
      requiredAmount: supplyAmountNano,
      label: 'Approve for deposit',
      assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: options.multiplyInputAmount.value },
      startIndex: idx,
    })
    signSteps.push(...collateralApproval.steps)
    idx = collateralApproval.nextIndex

    const sellTokenApproval = buildApprovalSignSteps({
      tokenAddress: shortVault.asset.address,
      currentAllowance: sellTokenAllowance,
      requiredAmount: sellAmount,
      label: 'Approve for swap',
      assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address, amount: borrowAmountStr },
      startIndex: idx,
    })
    signSteps.push(...sellTokenApproval.steps)
    idx = sellTokenApproval.nextIndex

    signSteps.push({ index: idx++, label: 'Sign EVC permit', isSeparateTx: false })
    signSteps.push({ index: idx++, label: 'Sign CoW order', isSeparateTx: false })

    const collateralVaultName = options.multiplySupplyProduct.value.name || undefined
    const borrowVaultName = options.multiplyShortProduct.value.name || undefined
    let wIdx = 1
    const wrapperSteps: DisplayStep[] = [
      { index: wIdx++, label: 'Enable collateral', labelSuffix: collateralVaultName, isSeparateTx: false, assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address } },
      { index: wIdx++, label: 'Enable controller', labelSuffix: borrowVaultName, isSeparateTx: false, assetInfo: { symbol: borrowAsset.symbol, address: borrowAsset.address } },
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
      quoteFetchedAt: options.multiplyEffectiveQuoteFetchedAt.value,
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
