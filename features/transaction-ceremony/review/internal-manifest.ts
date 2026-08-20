import type { Hash } from 'viem'
import { deepFreezeSerializable } from '../domain/canonical'
import type { CeremonyManifest } from '../domain/ceremony'
import type { ExecutionTemplate } from '../domain/template'

export const buildInternalManifest = (template: ExecutionTemplate, templateDigest: Hash): Readonly<CeremonyManifest> => {
  const requestByEffect = new Map<Hash, Hash>()
  for (const request of template.requests) {
    const requestId = 'requestId' in request ? request.requestId : request.callId
    for (const effectId of request.effectIds) {
      if (requestByEffect.has(effectId)) throw new Error(`Effect ${effectId} is represented by more than one request`)
      requestByEffect.set(effectId, requestId)
    }
  }
  const entries = template.effects.map((effect) => {
    const requestId = requestByEffect.get(effect.effectId)
    if (!requestId) throw new Error(`Effect ${effect.effectId} is absent from the transport template`)
    return {
      effectId: effect.effectId,
      intentId: effect.intentId,
      intentRevision: effect.intentRevision,
      requestId,
      coverage: effect.simulation.kind,
    }
  })
  const manifest: CeremonyManifest = {
    schemaVersion: 1,
    templateDigest,
    entries,
    previewPayloadHashes: template.pythRefreshSlots.map(slot => slot.previewPayloadHash),
  }
  return deepFreezeSerializable(manifest) as Readonly<CeremonyManifest>
}
