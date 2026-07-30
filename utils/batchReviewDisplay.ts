import type { DisplayStep } from '~/utils/stepDecoding'

export interface AuthorizationStepsDisplay {
  detailHeading: 'Authorization transactions' | 'Signatures'
  summaryHeading: 'Authorization transactions' | 'Signatures needed'
  itemCountLabel: '1 transaction' | '1 signature'
}

export const getAuthorizationStepDisplay = (
  isSeparateTx: DisplayStep['isSeparateTx'],
): AuthorizationStepsDisplay => {
  return isSeparateTx
    ? {
        detailHeading: 'Authorization transactions',
        summaryHeading: 'Authorization transactions',
        itemCountLabel: '1 transaction',
      }
    : {
        detailHeading: 'Signatures',
        summaryHeading: 'Signatures needed',
        itemCountLabel: '1 signature',
      }
}
