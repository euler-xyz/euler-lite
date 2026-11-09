import { readonly, ref } from 'vue'

const exitOnly = ref(false)

export const isAddressExitOnly = readonly(exitOnly)

export const setAddressExitOnly = (value: boolean): void => {
  exitOnly.value = value
}

export const ADDRESS_EXIT_ONLY_TITLE = 'Repay and withdraw only'
export const ADDRESS_EXIT_ONLY_MESSAGE = 'This address can only repay and withdraw. Repay any debt before withdrawing its collateral.'
