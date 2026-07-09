import { createError, readBody } from 'h3'
import { logger } from '~/server/utils/logger'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  resolveTenderlyConfig,
  viemStateOverridesToTenderly,
  type ViemStateOverrideEntry,
} from '~/server/utils/tenderly'
import { isAbortError } from '~/utils/errorHandling'

const UPSTREAM_TIMEOUT_MS = 30_000

const rateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
  label: 'tenderly',
})

interface SimulateRequest {
  chainId: number
  from: string
  to: string
  data: string
  value: string
  stateOverrides: ViemStateOverrideEntry[]
}

interface TenderlySimulationResult {
  id?: string
  status?: boolean
  error_message?: string | null
}

interface TenderlyTransactionResult {
  status?: boolean
  error_message?: string | null
  transaction_info?: {
    error_message?: string | null
  }
}

interface TenderlySimulateResponse {
  simulation?: TenderlySimulationResult
  transaction?: TenderlyTransactionResult
  error_message?: string | null
}

function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

function isValidAddress(value: unknown): value is string {
  return isValidHex(value) && (value as string).length === 42
}

function isValidValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return /^(0x[0-9a-fA-F]+|0|[1-9]\d*)$/.test(value)
}

function isValidStateOverride(entry: unknown): entry is ViemStateOverrideEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  if (!isValidAddress(e.address)) return false
  if (e.stateDiff !== undefined) {
    if (!Array.isArray(e.stateDiff)) return false
    for (const diff of e.stateDiff) {
      if (!diff || typeof diff !== 'object') return false
      const d = diff as Record<string, unknown>
      if (!isValidHex(d.slot) || !isValidHex(d.value)) return false
    }
  }
  return true
}

function getTenderlySimulationErrorMessage(response: TenderlySimulateResponse): string | undefined {
  const candidates = [
    response.transaction?.error_message,
    response.transaction?.transaction_info?.error_message,
    response.simulation?.error_message,
    response.error_message,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  const status = response.simulation?.status ?? response.transaction?.status
  if (status === false) {
    return 'The simulated transaction reverted.'
  }

  return undefined
}

export default defineEventHandler(async (event) => {
  const config = resolveTenderlyConfig()
  if (!config) {
    logger.warn({ ctx: 'tenderly-simulate', reason: 'not-configured' }, 'request rejected')
    throw createError({ statusCode: 503, statusMessage: 'Tenderly not configured' })
  }

  const body = await readBody<SimulateRequest>(event)

  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }

  const { chainId, from, to, data, value, stateOverrides } = body
  const calldataBytes = typeof data === 'string' && data.startsWith('0x') ? Math.floor((data.length - 2) / 2) : undefined
  const stateOverrideCount = Array.isArray(stateOverrides) ? stateOverrides.length : 0

  if (!Number.isFinite(chainId)) {
    logger.warn({ ctx: 'tenderly-simulate', reason: 'invalid-chain-id' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  if (!isValidAddress(from) || !isValidAddress(to)) {
    logger.warn({ ctx: 'tenderly-simulate', chainId, reason: 'invalid-address' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid from or to address' })
  }

  if (!isValidHex(data)) {
    logger.warn({ ctx: 'tenderly-simulate', chainId, reason: 'invalid-calldata' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid calldata' })
  }

  // 64 KB of hex chars = 32 KB of actual calldata, well above any normal transaction
  if (data.length > 131072) {
    logger.warn({ ctx: 'tenderly-simulate', chainId, reason: 'calldata-too-large', calldataBytes }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Calldata too large' })
  }

  if (value !== undefined && value !== '' && !isValidValue(value)) {
    logger.warn({ ctx: 'tenderly-simulate', chainId, reason: 'invalid-value' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid value' })
  }

  rateLimiter.consume(event)

  const MAX_STATE_OVERRIDES = 50
  const validatedOverrides = Array.isArray(stateOverrides)
    ? stateOverrides.slice(0, MAX_STATE_OVERRIDES).filter(isValidStateOverride)
    : []

  const baseUrl = `https://api.tenderly.co/api/v1/account/${config.accountSlug}/project/${config.projectSlug}`
  const headers = {
    'X-Access-Key': config.accessKey,
    'Content-Type': 'application/json',
  }

  const stateObjects = viemStateOverridesToTenderly(validatedOverrides)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const requestBody = {
      from,
      to,
      input: data,
      value: value || '0',
      network_id: String(chainId),
      save: true,
      save_if_fails: true,
      simulation_type: 'full',
      state_objects: stateObjects,
    }

    const simulateResponse = await fetch(`${baseUrl}/simulate`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    })

    if (!simulateResponse.ok) {
      await simulateResponse.text().catch(() => {})
      logger.warn(
        { ctx: 'tenderly-simulate', chainId, status: simulateResponse.status, calldataBytes, stateOverrideCount },
        'simulation request failed',
      )
      throw createError({
        statusCode: 502,
        statusMessage: 'Simulation request failed',
      })
    }

    const simulateData = await simulateResponse.json() as TenderlySimulateResponse
    const simulationId = simulateData?.simulation?.id

    if (!simulationId) {
      logger.warn(
        { ctx: 'tenderly-simulate', chainId, calldataBytes, stateOverrideCount, hasSimulationId: false },
        'simulation id missing',
      )
      throw createError({ statusCode: 502, statusMessage: 'No simulation ID returned' })
    }

    const shareResponse = await fetch(`${baseUrl}/simulations/${simulationId}/share`, {
      method: 'POST',
      headers,
      signal: controller.signal,
    })

    if (!shareResponse.ok) {
      return {
        url: `https://tdly.co/shared/simulation/${simulationId}`,
        errorMessage: getTenderlySimulationErrorMessage(simulateData),
      }
    }

    return {
      url: `https://tdly.co/shared/simulation/${simulationId}`,
      errorMessage: getTenderlySimulationErrorMessage(simulateData),
    }
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      logger.warn(
        { ctx: 'tenderly-simulate', chainId, calldataBytes, stateOverrideCount, timeout: true },
        'Tenderly API timeout',
      )
      throw createError({ statusCode: 504, statusMessage: 'Tenderly API timeout' })
    }
    if (error && typeof error === 'object' && 'statusCode' in error) {
      throw error
    }
    logger.warn(
      { ctx: 'tenderly-simulate', chainId, calldataBytes, stateOverrideCount, err: error },
      'Tenderly API error',
    )
    throw createError({ statusCode: 502, statusMessage: 'Tenderly API error' })
  }
  finally {
    clearTimeout(timeout)
  }
})
