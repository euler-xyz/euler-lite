import type { Hash } from 'viem'
import { deepFreezeSerializable } from '../domain/canonical'
import type { ReviewedSimulation, SimulationEffectResult, ReviewedRequestSet } from '../domain/reviewed-execution'

export interface EulerSimulationProjection {
  canExecute: boolean
  simulatedAccounts: readonly unknown[]
  simulatedVaults: readonly unknown[]
  blockNumber?: bigint
  error?: string
}

export const validateSimulationCoverage = (requestSet: ReviewedRequestSet) => {
  const independent = requestSet.effects.filter(node => node.simulation.kind === 'independent-call')
  const notStateSimulated = requestSet.effects.filter(node => node.simulation.kind === 'not-state-simulated')
  const evc = requestSet.effects.filter(node => node.simulation.kind === 'evc-state')

  if (independent.length) {
    if (independent.length !== requestSet.effects.length || independent.length !== 1 || evc.length || notStateSimulated.length) {
      throw new Error('Independent direct-call simulation is allowed only for one direct-only plan')
    }
    if (independent[0].effect.kind !== 'direct-call' || independent[0].dependsOn.length) {
      throw new Error('Independent direct call must not depend on another effect')
    }
  }
  if (notStateSimulated.length && evc.length) throw new Error('An unsimulated direct call cannot be combined with an EVC state simulation')
  if (notStateSimulated.some(node => node.effect.kind !== 'direct-call')) throw new Error('Only direct calls may be allowlisted as not state-simulated')
}

export const buildReviewedSimulation = ({
  requestSet,
  requestDigest,
  projection,
  observedAt,
}: {
  requestSet: ReviewedRequestSet
  requestDigest: Hash
  projection?: EulerSimulationProjection
  observedAt: number
}): Readonly<ReviewedSimulation> => {
  validateSimulationCoverage(requestSet)
  const hasStateCoverage = requestSet.effects.some(node => node.simulation.kind === 'evc-state' || node.simulation.kind === 'independent-call')
  if (hasStateCoverage && !projection) throw new Error('State-simulated effects require an SDK simulation projection')

  const effects: SimulationEffectResult[] = requestSet.effects.map((node) => {
    if (node.simulation.kind === 'modeled-authorization') {
      return { effectId: node.effectId, coverage: 'modeled-authorization', canExecute: true, assumption: node.simulation.assumption }
    }
    if (node.simulation.kind === 'not-state-simulated') {
      return { effectId: node.effectId, coverage: 'not-state-simulated', canExecute: true, assumption: `Allowlist: ${node.simulation.allowlistId}` }
    }
    return {
      effectId: node.effectId,
      coverage: node.simulation.kind,
      canExecute: projection?.canExecute === true,
      ...(projection?.error ? { error: projection.error } : {}),
    }
  })

  const hasIndependent = effects.some(effect => effect.coverage === 'independent-call')
  if (hasIndependent && projection && (projection.simulatedAccounts.length || projection.simulatedVaults.length)) {
    throw new Error('Independent direct-call simulation must return an empty Euler state projection')
  }

  const simulation: ReviewedSimulation = {
    schemaVersion: 1,
    requestDigest,
    observedAt,
    ...(projection?.blockNumber !== undefined ? { blockNumber: projection.blockNumber } : {}),
    canExecute: effects.every(effect => effect.canExecute),
    effects,
    simulatedAccounts: projection?.simulatedAccounts.map(value => value as never) ?? [],
    simulatedVaults: projection?.simulatedVaults.map(value => value as never) ?? [],
  }
  return deepFreezeSerializable(simulation) as Readonly<ReviewedSimulation>
}
