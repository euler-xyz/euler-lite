import { createInFlightDedup } from './in-flight'
import { liquidationBotBaseUrl, readLiquidationBotApiConfig } from './liquidation-bot-api-url'
import { reportStatus } from './log'
import { logger } from './logger'
import {
  parseVaultFilter,
  type LiquidationBotFilterMode,
  type LiquidationCoverage,
} from '~/utils/liquidation-coverage'

const FRESH_MS = 5 * 60_000
/** A short outage or a bot redeploy keeps its last answer; a bot down longer counts as no bot. */
const LAST_GOOD_MS = 30 * 60_000
const RETRY_FLOOR_MS = 60_000
const FETCH_TIMEOUT_MS = 5_000
const LOG_CONTEXT = 'liquidation-coverage'

interface Answer {
  readonly mode: LiquidationBotFilterMode
  readonly vaults: readonly string[]
  readonly fetchedAt: number
}

interface ChainState {
  readonly lastGood?: Answer
  readonly lastFailureAt?: number
}

const states = new Map<number, ChainState>()
const inFlight = createInFlightDedup<number, LiquidationCoverage>()
let invalidConfigReported = false

const answered = (chainId: number, answer: Answer): LiquidationCoverage => ({
  enabled: true,
  chainId,
  state: 'answered',
  mode: answer.mode,
  vaults: [...answer.vaults],
  fetchedAt: answer.fetchedAt,
})

const fallback = (chainId: number, state: ChainState, now: number): LiquidationCoverage =>
  state.lastGood && now - state.lastGood.fetchedAt < LAST_GOOD_MS
    ? answered(chainId, state.lastGood)
    : { enabled: true, chainId, state: 'no-bot' }

const readTemplate = (): string | null => {
  const config = readLiquidationBotApiConfig()
  if (config.status === 'invalid' && !invalidConfigReported) {
    invalidConfigReported = true
    logger.error({ ctx: LOG_CONTEXT, reason: config.reason }, 'liquidation bot coverage is off: invalid configuration')
  }
  return config.status === 'on' ? config.template : null
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  }
  catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new Error('vault-filter answer is not JSON', { cause: err })
  }
}

/** One deadline for the headers and the body: fetchWithTimeout stops timing once the headers arrive. */
const fetchAnswer = async (template: string, chainId: number): Promise<Answer> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${liquidationBotBaseUrl(template, chainId)}/vault-filter`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`vault-filter returned ${response.status}`)
    const filter = parseVaultFilter(await readJson(response))
    if (!filter) throw new Error('vault-filter answer is not a vault filter')
    return { ...filter, fetchedAt: Date.now() }
  }
  finally {
    clearTimeout(timer)
  }
}

const describeFailure = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  const code = (err.cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? `${err.message} (${code})` : err.message
}

const refresh = (template: string, chainId: number): Promise<LiquidationCoverage> =>
  inFlight.run(chainId, async () => {
    try {
      const answer = await fetchAnswer(template, chainId)
      states.set(chainId, { lastGood: answer })
      reportStatus(LOG_CONTEXT, `chain=${chainId}`, 'ok')
      return answered(chainId, answer)
    }
    catch (err) {
      const message = describeFailure(err)
      reportStatus(LOG_CONTEXT, `chain=${chainId}`, `failed:${message}`, `default liquidation bot did not answer: ${message}`)
      const now = Date.now()
      const failed: ChainState = { ...states.get(chainId), lastFailureAt: now }
      states.set(chainId, failed)
      return fallback(chainId, failed, now)
    }
  })

export async function getLiquidationCoverage(chainId: number): Promise<LiquidationCoverage> {
  const template = readTemplate()
  if (!template) return { enabled: false }
  const state = states.get(chainId) ?? {}
  const now = Date.now()
  const age = state.lastGood ? now - state.lastGood.fetchedAt : Number.POSITIVE_INFINITY
  const retryAllowed = state.lastFailureAt === undefined || now - state.lastFailureAt >= RETRY_FLOOR_MS
  if (state.lastGood && age < LAST_GOOD_MS) {
    if (age >= FRESH_MS && retryAllowed) void refresh(template, chainId)
    return answered(chainId, state.lastGood)
  }
  return retryAllowed ? refresh(template, chainId) : fallback(chainId, state, now)
}

export async function refreshLiquidationCoverage(chainId: number): Promise<LiquidationCoverage> {
  const template = readTemplate()
  return template ? refresh(template, chainId) : { enabled: false }
}

export const isLiquidationCoverageEnabled = (): boolean => readTemplate() !== null
