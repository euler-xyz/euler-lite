export type ToastVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral'
export type ToastSize = 'normal' | 'compact'
export type ToastPresentation = 'inline' | 'floating'

export interface Toast {
  id: string
  variant?: ToastVariant
  size?: ToastSize
  presentation?: ToastPresentation
  title: string
  description?: string
  actionText?: string
  persistent?: boolean
  duration?: number
  onAction?: () => void
}
