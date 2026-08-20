import type { Hash } from 'viem'
import { deepFreezeSerializable } from '../domain/canonical'
import type { EffectMap, ReviewedRequestSet } from '../domain/reviewed-execution'

export const buildEffectMap = (requestSet: ReviewedRequestSet, requestDigest: Hash): Readonly<EffectMap> => {
  const requestByEffect = new Map<Hash, Hash>()
  for (const request of requestSet.requests) {
    const requestId = 'requestId' in request ? request.requestId : request.callId
    for (const effectId of request.effectIds) {
      if (requestByEffect.has(effectId)) throw new Error(`Effect ${effectId} is represented by more than one request`)
      requestByEffect.set(effectId, requestId)
    }
  }
  const entries = requestSet.effects.map((effect) => {
    const requestId = requestByEffect.get(effect.effectId)
    if (!requestId) throw new Error(`Effect ${effect.effectId} is absent from the transport request set`)
    return {
      effectId: effect.effectId,
      intentId: effect.intentId,
      intentRevision: effect.intentRevision,
      requestId,
      coverage: effect.simulation.kind,
    }
  })
  const effectMap: EffectMap = {
    schemaVersion: 1,
    requestDigest,
    entries,
    previewPayloadHashes: requestSet.pythRefreshSlots.map(slot => slot.previewPayloadHash),
  }
  return deepFreezeSerializable(effectMap) as Readonly<EffectMap>
}
