import type { Hex } from 'viem'
import type { SignedMigrationAuthorization } from '@eulerxyz/euler-v2-sdk'
import type { PreparedPlanSignatureSubstitution } from '~/utils/preparedPlanParity'

export const PLACEHOLDER_MIGRATION_AUTHORIZATION_SIGNATURE = `0x${'00'.repeat(65)}` as Hex

export const getMigrationAuthorizationSignatureSubstitutions = (
  authorization: SignedMigrationAuthorization | undefined,
): PreparedPlanSignatureSubstitution[] => {
  if (!authorization) return []
  return [
    {
      placeholder: PLACEHOLDER_MIGRATION_AUTHORIZATION_SIGNATURE,
      signature: authorization.signature,
    },
    ...getMigrationAuthorizationSignatureSubstitutions(authorization.postMigrationAuthorization),
  ]
}
