import type { Ref, ComputedRef } from 'vue'
import { erc20Abi, formatUnits, maxUint256, type Address } from 'viem'
import type { EVault, SwapQuote, Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import type { CowSwapOpenPositionExecuteParams } from '~/composables/cowswap'
import { logWarn } from '~/utils/errorHandling'
import type { DisplayStep } from '~/utils/stepDecoding'
import {
  COWSWAP_ORDER_DEADLINE_SECONDS,
  getCowSwapQuoteOrderAmounts,
  getCowSwapChainConfig,
  isCowProvider,
  isCowQuote,
  isCowSwapSupportedChain,
} from '~/entities/cowswap'
import { useCowSwapOpenPositionExecution, useCowSwapOrderStatus, openCowSwapReviewModal, buildApprovalSignSteps } from '~/composables/cowswap'
import { useModal } from '~/components/ui/composables/useModal'
import { useToast } from '~/components/ui/composables/useToast'
import { trimTrailingZeros } from '~/utils/string-utils'
import { getNewSubAccount } from '~/composables/useSubAccounts'
import { prepareMooolerSound, playMooolerSound } from '~/utils/moooler-sound'

const convertVaultSharesToAssets = (vault: EVault, sharesAmount: bigint): bigint => {
  if (sharesAmount <= 0n) return 0n
  if (vault.totalShares <= 0n) return sharesAmount
  return (sharesAmount * vault.totalAssets) / vault.totalShares
}

interface UseMultiplyCowSwapOptions {
  multiplySelectedProvider: ComputedRef<string | null>
  multiplyEffectiveQuote: ComputedRef<SwapQuote | null>
  multiplySelectedQuote: ComputedRef<SwapQuote | null>
  multiplyEffectiveQuoteFetchedAt: ComputedRef<number | null>
  multiplySlippage: Readonly<Ref<number>>
  multiplySupplyVault: ComputedRef<EVault | undefined>
  multiplyLongVault: ComputedRef<EVault | undefined>
  multiplyShortVault: ComputedRef<EVault | undefined>
  multiplySupplyProduct: ComputedRef<{ name: string }>
  multiplyShortProduct: ComputedRef<{ name: string }>
  multiplyInputAmount: Ref<string>
  multiplyShortAmount: ComputedRef<string>
  multiplyLongAmount: ComputedRef<string>
  multiplyDebtAmountNano: ComputedRef<bigint>
  multiplyErrorText: ComputedRef<string | null>
  account: ComputedRef<Account<IHasVaultAddress> | undefined>
}

export const useMultiplyCowSwap = (options: UseMultiplyCowSwapOptions) => {
  const { address } = useWagmi()
  const router = useRouter()
  const modal = useModal()
  const { error } = useToast()
  const { client: rpcClient } = useRpcClient()
  const { chainId: currentChainId } = useEulerAddresses()
  const { refreshAllPositions } = useEulerAccount()

  const cowSwapExecution = useCowSwapOpenPositionExecution()
  const cowSwapOrderStatus = useCowSwapOrderStatus(cowSwapExecution.orderUid, currentChainId)

  const isCowSwapProvider = computed(() =>
    isCowProvider(options.multiplySelectedProvider.value)
    || (!options.multiplySelectedProvider.value && isCowQuote(options.multiplyEffectiveQuote.value)),
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
      playMooolerSound()
      refreshAllPositions(undefined, address.value || '')
      modal.close()
      setTimeout(() => {
        router.replace('/portfolio')
        cowSwapExecution.reset()
      }, 400)
    }
    // else: leave terminal status visible until user dismisses the modal.
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

    // CoW pre-flight: orders can't be simulated, so the multiply form's
    // existing errorText already screens most failure modes — but it doesn't
    // see the post-swap collateral amount that we're about to push into the
    // long vault. Guard against exceeding the supply cap on the long side.
    const longCap = longVault.caps?.supplyCap
    if (typeof longCap === 'bigint' && longCap > 0n && longCap < maxUint256) {
      const buyAmount = BigInt(quote.amountOut || '0')
      if (longVault.totalAssets + buyAmount > longCap) {
        error('Long vault supply cap would be exceeded')
        return
      }
    }

    const chainId = currentChainId.value ?? 0
    if (!isCowSwapSupportedChain(chainId)) return

    if (!address.value) return

    // Resolve the sub-account that the quote was scoped to. We pick a free
    // sub-account with no conflicting controller for the borrow vault — this
    // is the same selection the quote was built against. If the freshly
    // selected one differs from the quote's account, the quote is stale.
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

    const account = options.account.value
    if (!account) {
      error('Account not ready')
      return
    }

    const supplyAmountNano = valueToNano(options.multiplyInputAmount.value || '0', supplyVault.asset.decimals)
    const validTo = Math.floor(Date.now() / 1000) + COWSWAP_ORDER_DEADLINE_SECONDS

    // For the review modal we still want to show CoW order amounts (sell/buy)
    // even though `planOpenPositionWithCoW` derives them internally too — they
    // need to be displayed before plan execution.
    const orderAmounts = getCowSwapQuoteOrderAmounts(quote, {
      slippage: options.multiplySlippage.value,
      slippageTarget: 'buyAmount',
    })
    if (!orderAmounts) {
      error('Invalid quote: missing CoW order amounts')
      return
    }
    const { sellAmount, buyAmount } = orderAmounts

    const cowParams: CowSwapOpenPositionExecuteParams = {
      chainId,
      account: account as Account<IHasVaultAddress>,
      collateralVault: supplyVault.address as Address,
      collateralAmount: supplyAmountNano,
      collateralAsset: supplyVault.asset.address as Address,
      swapQuote: quote,
      slippage: options.multiplySlippage.value,
      validTo,
    }

    // Read allowances for review-modal sign-step display (USDT-style reset check).
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
          authorizationList: undefined,
          args: [address.value as Address, supplyVault.address as Address],
        }) as bigint

        if (chainConfig) {
          sellTokenAllowance = await client.readContract({
            address: shortVault.asset.address as Address,
            abi: erc20Abi,
            functionName: 'allowance',
            authorizationList: undefined,
            args: [address.value as Address, chainConfig.vaultRelayer],
          }) as bigint
        }
      }
    }
    catch {
      // Fall through — show approval steps by default.
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
      chainId,
      tokenAddress: supplyVault.asset.address as Address,
      currentAllowance: collateralAllowance,
      requiredAmount: supplyAmountNano,
      label: 'Approve for deposit',
      assetInfo: { symbol: collateralAsset.symbol, address: collateralAsset.address, amount: options.multiplyInputAmount.value },
      startIndex: idx,
    })
    signSteps.push(...collateralApproval.steps)
    idx = collateralApproval.nextIndex

    const sellTokenApproval = buildApprovalSignSteps({
      chainId,
      tokenAddress: shortVault.asset.address as Address,
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
      = `The CoW order is signed with buy amounts in ${collateralAsset.symbol}-vault shares. `
        + `The amounts shown above are in ${collateralAsset.symbol} (underlying). `
        + 'The CoW order receiver is your sub-account, not your main wallet — your wallet may flag this as a mismatch. '
        + 'You can verify the first 19 bytes (38 hex chars after "0x") of the receiver match your wallet address.'

    prepareMooolerSound()
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
