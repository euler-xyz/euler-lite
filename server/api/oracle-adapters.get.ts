import { createOracleChecksHandler } from '~/server/utils/oracle-checks'

export default createOracleChecksHandler({
  resource: 'adapters',
  label: 'oracle-adapters',
  max: 60,
  logMessage: 'fetch all.json failed',
})
