import { createError, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  resolveTenderlyConfig,
  viemStateOverridesToTenderly,
  type ViemStateOverrideEntry,
} from '~/server/utils/tenderly'
import { isAbortError } from '~/utils/errorHandling'

const UPSTREAM_TIMEOUT_MS = 30_000

const rateLimiter = createRateLimiter({
  max: 5,
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

export default defineEventHandler(async (event) => {
  const config = resolveTenderlyConfig()
  if (!config) {
    throw createError({ statusCode: 503, statusMessage: 'Tenderly not configured' })
  }

  const body = await readBody<SimulateRequest>(event)

  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Missing request body' })
  }

  const { chainId, from, to, data, value, stateOverrides } = body

  if (!Number.isFinite(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  if (!isValidAddress(from) || !isValidAddress(to)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid from or to address' })
  }

  if (!isValidHex(data)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid calldata' })
  }

  // 64 KB of hex chars = 32 KB of actual calldata, well above any normal transaction
  if (data.length > 131072) {
    throw createError({ statusCode: 400, statusMessage: 'Calldata too large' })
  }

  if (value !== undefined && value !== '' && !isValidValue(value)) {
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
      save: false,
      save_if_fails: false,
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
      throw createError({
        statusCode: 502,
        statusMessage: 'Simulation request failed',
      })
    }

    const simulateData = await simulateResponse.json() as { simulation?: { id?: string, status?: boolean } }
    const simulationId = simulateData?.simulation?.id

    if (!simulationId) {
      throw createError({ statusCode: 502, statusMessage: 'No simulation ID returned' })
    }

    const shareResponse = await fetch(`${baseUrl}/simulations/${simulationId}/share`, {
      method: 'POST',
      headers,
      signal: controller.signal,
    })

    if (!shareResponse.ok) {
      return { url: `https://tdly.co/shared/simulation/${simulationId}` }
    }

    return { url: `https://tdly.co/shared/simulation/${simulationId}` }
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      throw createError({ statusCode: 504, statusMessage: 'Tenderly API timeout' })
    }
    if (error && typeof error === 'object' && 'statusCode' in error) {
      throw error
    }
    throw createError({ statusCode: 502, statusMessage: 'Tenderly API error' })
  }
  finally {
    clearTimeout(timeout)
  }
})
