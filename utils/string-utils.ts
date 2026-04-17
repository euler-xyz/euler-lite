export const truncate = (string = '', length = 6) => {
  return string.slice(0, length) + '...' + string.slice(string.length - 4, string.length)
}

// Truncate address to first 19 bytes (0x + 38 hex chars) for subgraph optimization
export const truncateAddressForSubgraph = (address: string): string => {
  return address.toLowerCase().slice(0, 40)
}

export const formatNumber = (value: string | number = 0, maximumFractionDigits = 2, minimumFractionDigits = 2) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return num.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits })
}

/**
 * Format USD value with smart handling of small amounts.
 * - Shows "<$0.01" for small positive values (0 < value < 0.01)
 * - Shows "$0.00" for zero or negative tiny values
 * - Shows normal formatting for larger values
 */
export const formatUsdValue = (value: string | number = 0, maximumFractionDigits = 2): string => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return '$0.00'
  }
  if (numericValue > 0 && numericValue < 0.01) {
    return '<$0.01'
  }
  if (numericValue < 0 && numericValue > -0.01) {
    return '-<$0.01'
  }
  return `$${formatNumber(numericValue, maximumFractionDigits)}`
}

export const formatSignificant = (value: string | number = 0, maximumSignificantDigits = 2) => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return '0'
  }
  return new Intl.NumberFormat('en-US', {
    maximumSignificantDigits,
    useGrouping: false,
  }).format(numericValue)
}

/**
 * Like formatSignificant but truncates (floors) instead of rounding.
 * Use when the formatted value must never exceed the original (e.g. balance inputs).
 */
export const formatSignificantFloor = (value: string | number = 0, maximumSignificantDigits = 2): string => {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0) return '0'
  const abs = Math.abs(num)
  const magnitude = Math.floor(Math.log10(abs))
  const decimalPlaces = Math.max(0, maximumSignificantDigits - 1 - magnitude)
  const factor = 10 ** decimalPlaces
  const truncated = Math.floor(abs * factor) / factor
  const result = num < 0 ? -truncated : truncated
  return result.toFixed(decimalPlaces)
}

export const compactNumber = (value: string | number = 0, maximumFractionDigits = 2, minimumFractionDigits = 0) => {
  const formattedValue = Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits,
    minimumFractionDigits,
  }).format(Number(value))

  if (Number(value) > 0 && formattedValue === '0') return `<0.${'1'.padStart(maximumFractionDigits, '0')}`
  if (Number(value) < 0 && formattedValue === '-0') return '≈0'

  return formattedValue
}

/**
 * Format USD value with compact notation for large amounts.
 * - Shows "<$0.01" for small positive values (0 < value < 0.01)
 * - Shows "$0" for zero
 * - Uses compact notation (e.g., $1.5M, $2.3K) for larger values
 */
export const formatCompactUsdValue = (value: string | number = 0, maximumFractionDigits = 2): string => {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return '$0'
  }
  if (numericValue > 0 && numericValue < 0.01) {
    return '<$0.01'
  }
  if (numericValue < 0 && numericValue > -0.01) {
    return '-<$0.01'
  }
  return `$${compactNumber(numericValue, maximumFractionDigits)}`
}

/**
 * Format a bigint token amount with full decimal precision for exact-value tooltips.
 * Trims trailing zeros and adds thousand separators.
 * e.g. 1234567890000000000n with 18 decimals → "1.23456789"
 */
export const formatExactAmount = (amount: bigint, decimals: number | bigint, symbol?: string): string => {
  if (amount === 0n) return symbol ? `0 ${symbol}` : '0'

  const d = Number(decimals)
  const divisor = 10n ** BigInt(d)
  const integerPart = amount / divisor
  const fractionalPart = amount % divisor

  const formattedInt = integerPart.toLocaleString('en-US')

  if (fractionalPart === 0n) {
    return symbol ? `${formattedInt} ${symbol}` : formattedInt
  }

  // Pad fractional part to full decimal width, then trim trailing zeros
  const fracStr = fractionalPart.toString().padStart(d, '0').replace(/0+$/, '')

  const result = `${formattedInt}.${fracStr}`
  return symbol ? `${result} ${symbol}` : result
}

/**
 * Trim trailing zeros from a decimal string while keeping it parseable.
 * Intended for input fields where values are set programmatically.
 * "0.363002000000000000" → "0.363002"
 * "1.000000000000000000" → "1"
 * "0.10"                 → "0.1"
 */
export const trimTrailingZeros = (value: string): string => {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '')
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed
}

/**
 * Format a token amount with smart precision based on magnitude.
 * - >= 1000: no decimals (e.g., "1,234")
 * - >= 1: up to 4 decimals (e.g., "1.43")
 * - < 1 and > 0: shows enough decimals to display 2 significant digits (e.g., "0.0012")
 * - 0: "0"
 */
export const formatSmartAmount = (value: string | number = 0, maxDecimals = 6): string => {
  const num = Number(value)
  if (!Number.isFinite(num) || num === 0) return '0'

  const abs = Math.abs(num)

  if (abs >= 1000) {
    return formatNumber(num, 2, 2)
  }
  if (abs >= 1) {
    return formatNumber(num, 4, 0)
  }

  // For small values, find first significant digit and show 2 significant figures
  const str = abs.toFixed(18)
  const decimalIndex = str.indexOf('.')
  if (decimalIndex === -1) return formatNumber(num, 2, 0)

  const fractional = str.substring(decimalIndex + 1)
  let firstSigIndex = -1
  for (let i = 0; i < fractional.length; i++) {
    if (fractional[i] !== '0') {
      firstSigIndex = i
      break
    }
  }

  if (firstSigIndex === -1) return '0'

  const precision = Math.min(firstSigIndex + 2, maxDecimals)
  return formatNumber(num, precision, 0)
}

/**
 * Formats a health score value for display.
 * - null/undefined → "-"
 * - Infinity or extremely large (>1e15) → "∞"
 * - Normal → formatted to 2 decimals
 */
export const formatHealthScore = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '-'
  if (!Number.isFinite(value) || value > 1e15) return '∞'
  return formatNumber(value, 2)
}

export const preciseNumber = (value: string | number, decimals = 36) => {
  return Intl.NumberFormat('en-US', { maximumFractionDigits: decimals, useGrouping: false }).format(Number(value))
}

export const stringToColor = (value: string, saturation = 40, lightness = 45) => {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash)
    hash = hash & hash
  }
  return `hsl(${((hash % 360) + 360) % 360}, ${saturation}%, ${lightness}%)`
}
