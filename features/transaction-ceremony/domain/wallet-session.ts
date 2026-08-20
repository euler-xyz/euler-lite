import type { Hash } from 'viem'
import { canonicalDigest, toCanonicalValue } from './canonical'

export interface StableConnectorSessionIdentity {
  connectorId: string
  connectorName?: string
  connectorType?: string
  sessionTopic?: string
  pairingTopic?: string
  peerName?: string
  peerUrl?: string
}

/**
 * Bind a ceremony to durable connector/session identity. Wagmi connector UIDs
 * are intentionally excluded because they are regenerated on every app boot.
 */
export const connectorSessionDigest = (identity: StableConnectorSessionIdentity): Hash =>
  canonicalDigest('connector-session-v2', toCanonicalValue({
    connectorId: identity.connectorId,
    connectorName: identity.connectorName ?? '',
    connectorType: identity.connectorType ?? '',
    sessionTopic: identity.sessionTopic ?? '',
    pairingTopic: identity.pairingTopic ?? '',
    peerName: identity.peerName ?? '',
    peerUrl: identity.peerUrl ?? '',
  }))
