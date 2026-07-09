import { unref } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { useModal } from '~/components/ui/composables/useModal'
import { HighPriceImpactModal } from '#components'
import { isPriceImpactDanger } from '~/utils/priceImpact'

export const usePriceImpactGate = (options: {
  directPriceImpact: Ref<number | null> | ComputedRef<number | null>
  multipliedPriceImpact?: Ref<number | null> | ComputedRef<number | null>
  shouldGateUnknown?: Ref<boolean> | ComputedRef<boolean>
}) => {
  const modal = useModal()

  const isDanger = computed(() =>
    isPriceImpactDanger(unref(options.directPriceImpact))
    || isPriceImpactDanger(unref(options.multipliedPriceImpact) ?? null),
  )

  const isUnknown = computed(() =>
    Boolean(options.shouldGateUnknown && unref(options.shouldGateUnknown)),
  )

  const needsConfirmation = computed(() => isDanger.value || isUnknown.value)

  const guardWithPriceImpact = async (onProceed: () => void | Promise<void>) => {
    if (!needsConfirmation.value) {
      await onProceed()
      return
    }
    modal.open(HighPriceImpactModal, {
      props: {
        directPriceImpact: unref(options.directPriceImpact),
        multipliedPriceImpact: unref(options.multipliedPriceImpact) ?? null,
        unknown: isUnknown.value && !isDanger.value,
        onConfirm: async () => {
          modal.close()
          await onProceed()
        },
      },
    })
  }

  return { needsConfirmation, guardWithPriceImpact }
}
