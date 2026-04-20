export type DisabledReasonVariant = 'warning' | 'error'

export interface DisabledReasonInfo {
  message: string
  variant: DisabledReasonVariant
}
