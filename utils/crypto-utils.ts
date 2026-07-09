import { formatUnits, parseUnits } from 'viem'
import { TTL_ERROR, TTL_INFINITY, TTL_LIQUIDATION, TTL_MORE_THAN_ONE_YEAR } from '~/entities/constants'
import { compactNumber } from '~/utils/string-utils'

export const nanoToValue = (src: bigint | number | string, decimals: number | bigint = 9) => {
  return +formatUnits(BigInt(src), Number(decimals))
}

const expandScientificNotation = (src: string): string => {
  const match = src.match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/)
  if (!match) return src

  const [, sign, intPart, fracPart = '', exponentRaw] = match
  const digits = `${intPart}${fracPart}`
  const decimalIndex = intPart.length + Number(exponentRaw)

  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`
}

export const valueToNano = (src: number | string, decimals: number | bigint = 9) => {
  if (!src) {
    return 0n
  }
  const decimalsNumber = Number(decimals)
  const parts = expandScientificNotation(String(src).trim()).split('.')
  const value = parts[0] + '.' + (parts[1] || '').substring(0, decimalsNumber)
  return parseUnits(value, decimalsNumber)
}

export const ltvToPercent = (src: bigint | number) => {
  return typeof src === 'number' ? src * 100 : nanoToValue(src, 2)
}

export interface FormatTtlResult {
  display: string
  type: 'success' | 'error' | 'warning' | 'info'
  days?: number
}

export function formatTtl(ttl?: bigint): FormatTtlResult | undefined {
  if (ttl === undefined || ttl === null) {
    return undefined
  }

  if (ttl === TTL_INFINITY) {
    return { display: '∞', type: 'success' }
  }

  if (ttl === TTL_MORE_THAN_ONE_YEAR) {
    return { display: '>1 year', type: 'success' }
  }

  if (ttl === TTL_LIQUIDATION) {
    return { display: 'Eligible for liquidation', type: 'error' }
  }

  if (ttl === TTL_ERROR) {
    return { display: 'Error', type: 'error' }
  }

  if (ttl === 0n) {
    return { display: '<1 day', type: 'error' }
  }

  const days = Number(ttl)

  if (isNaN(days) || days < 0) {
    return undefined
  }

  if (days < 1) {
    return { display: '<1 day', type: 'error', days }
  }

  if (days < 2) {
    return { display: `${days} day`, type: 'error', days }
  }

  if (days < 7) {
    return { display: `${days} days`, type: 'warning', days }
  }

  if (days < 14) {
    return { display: `${days} days`, type: 'info', days }
  }

  return { display: `${days} days`, type: 'success', days }
}

export function formatTtlRelative(ttl?: bigint): string {
  const result = formatTtl(ttl)

  if (!result) {
    return '-'
  }

  if (result.days !== undefined && result.days >= 1) {
    return `in ${result.display}`
  }

  return result.display
}

export const roundAndCompactTokens = (amount: bigint, decimals: number | bigint): string => {
  if (amount === 0n) {
    return '0'
  }

  const value = nanoToValue(amount, decimals)

  if (value === 0) {
    return '0'
  }

  const valueStr = value.toFixed(18)

  const decimalIndex = valueStr.indexOf('.')
  if (decimalIndex === -1) {
    return valueStr
  }

  const fractionalPart = valueStr.substring(decimalIndex + 1)
  let firstSignificantIndex = -1

  for (let i = 0; i < fractionalPart.length; i++) {
    if (fractionalPart[i] !== '0') {
      firstSignificantIndex = i
      break
    }
  }

  if ([0, 1].includes(firstSignificantIndex) || value >= 1) {
    return compactNumber(value, 2)
  }

  if (firstSignificantIndex === -1) {
    return '0'
  }

  const precision = firstSignificantIndex + 1
  const multiplier = Math.pow(10, precision)
  const rounded = Math.round(value * multiplier) / multiplier

  return compactNumber(rounded, precision)
}
