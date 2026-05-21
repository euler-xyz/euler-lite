export type ToastVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral'
export type ToastSize = 'normal' | 'compact'

export interface Toast {
  id: string
  variant?: ToastVariant
  size?: ToastSize
  title: string
  description?: string
  actionText?: string
  persistent?: boolean
  duration?: number
  onAction?: () => void
}
