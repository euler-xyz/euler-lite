import { BaseError } from 'viem'

const MAX_COW_SWAP_ERROR_MESSAGE_LENGTH = 180

const trimDiagnosticDetails = (message: string): string => {
  const diagnosticIndex = [
    'Request Arguments:',
    'Contract Call:',
    'Details:',
    'Version:',
  ]
    .map(marker => message.indexOf(marker))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]

  return (diagnosticIndex === undefined ? message : message.slice(0, diagnosticIndex)).trim()
}

const truncateMessage = (message: string): string => {
  if (message.length <= MAX_COW_SWAP_ERROR_MESSAGE_LENGTH) return message
  return `${message.slice(0, MAX_COW_SWAP_ERROR_MESSAGE_LENGTH).trimEnd()}...`
}

export const formatCowSwapExecutionErrorMessage = (error: Error): string => {
  const shortMessage = error instanceof BaseError ? error.shortMessage : error.message
  const cleaned = trimDiagnosticDetails(shortMessage || error.message)
  return truncateMessage(cleaned || 'Something went wrong')
}
