import { createOracleChecksHandler } from '~/server/utils/oracle-checks'

export default createOracleChecksHandler({
  resource: 'routers',
  label: 'oracle-routers',
  max: 60,
  logMessage: 'fetch routers all.json failed',
})
